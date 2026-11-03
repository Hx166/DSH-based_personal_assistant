// bridge/vector.mjs — 向量通道的 Node 侧：worker 生命周期、超时、静默降级。
//
// 原则：
//   1. 向量只是加速器，任何失败都返回 {ok:false, reason}，由调用方降级为纯 FTS，绝不抛错中断召回。
//   2. worker 懒启动；MEM_VECTOR=off 时完全不启动。闲置 MEM_VECTOR_IDLE_MS（默认 10 分钟）自杀；
//      父进程退出时同步杀掉子进程。
//   3. 默认 transport 是 stdio 管道（一行一条 JSON）。个别受限环境（例如禁止创建匿名管道）
//      spawn 会直接 EPERM，此时自动退回文件中继（--relay），协议不变。
//
// 环境变量：
//   MEM_VECTOR=off|auto|on       默认 auto（auto 时解释器不存在就不启动）
//   MEM_VECTOR_PY=PATH           解释器（默认 ollama_ai 环境）
//   MEM_VECTOR_DIR=DIR           Chroma 目录（默认 <索引库所在目录>/vector）
//   MEM_VECTOR_MODEL / MEM_VECTOR_DIM / MEM_VECTOR_OLLAMA
//   MEM_VECTOR_QUERY_PREFIX / MEM_VECTOR_DOC_PREFIX / MEM_VECTOR_NO_QUERY_PREFIX=1
//   MEM_VECTOR_IDLE_MS / MEM_VECTOR_WORKER（换 worker 脚本，测试用）
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openIndex, closeIndex, getNotesByIds } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_SCRIPT = path.join(HERE, 'vector_worker.py');
export const DEFAULT_PYTHON = 'D:\\Anaconda3\\envs\\ollama_ai\\python.exe';
export const DEFAULT_MODEL = 'dengcao/Qwen3-Embedding-0.6B:Q8_0';
export const DEFAULT_DIM = 1024;
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
export const DEFAULT_COLLECTION = 'notes';
/** Qwen3-Embedding 官方查询指令模板；可按 MEM_VECTOR_NO_QUERY_PREFIX=1 关掉 */
export const DEFAULT_QUERY_PREFIX =
  'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

const OP_TIMEOUT_MS = 5000;
const FIRST_TIMEOUT_MS = 30000;
const REBUILD_TIMEOUT_MS = 120000;
/** 增量同步的总预算：写链路只做 fire-and-forget，超时就放弃本轮（下次写入/维护再补） */
const SYNC_TIMEOUT_MS = 2000;
const POLL_MS = 10;
const HARD_REASONS = new Set([
  'count_mismatch', 'metadata_mismatch', 'bad_config', 'chromadb_missing',
  'python_missing', 'spawn_failed', 'unknown_op',
]);

const sessions = new Map();
let exitHooked = false;

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  // 父进程退出即退：同步杀子进程（管道模式下这就是唯一清理点）
  process.on('exit', () => {
    for (const session of sessions.values()) session.killSync();
  });
}

/** off → 不碰 worker；auto → 解释器缺失就跳过；on → 无论如何尝试一次 */
export function vectorMode(value = null) {
  const raw = value === undefined || value === null ? (process.env.MEM_VECTOR ?? 'auto') : value;
  if (raw === false) return 'off';
  if (raw === true) return 'on';
  const text = String(raw).trim().toLowerCase();
  if (text === 'off' || text === '0' || text === 'false' || text === 'no') return 'off';
  if (text === 'on' || text === '1' || text === 'true' || text === 'yes' || text === 'force') return 'on';
  return 'auto';
}

/** 向量目录默认跟着索引库走：生产是 ../runtime/vector，测试各用各的临时目录 */
export function defaultVectorDir(dbPath) {
  const db = dbPath && dbPath !== ':memory:' ? path.resolve(dbPath) : path.resolve(HERE, '..', '..', 'runtime', 'index.db');
  return path.join(path.dirname(db), 'vector');
}

export function vectorConfig({ dbPath = null, dir = null } = {}) {
  const resolvedDir = dir || process.env.MEM_VECTOR_DIR || defaultVectorDir(dbPath);
  const noPrefix = truthy(process.env.MEM_VECTOR_NO_QUERY_PREFIX);
  const queryPrefix = noPrefix
    ? ''
    : (process.env.MEM_VECTOR_QUERY_PREFIX ?? DEFAULT_QUERY_PREFIX);
  return {
    dir: path.resolve(String(resolvedDir)),
    python: process.env.MEM_VECTOR_PY || DEFAULT_PYTHON,
    worker: process.env.MEM_VECTOR_WORKER || WORKER_SCRIPT,
    model: process.env.MEM_VECTOR_MODEL || DEFAULT_MODEL,
    dim: Number(process.env.MEM_VECTOR_DIM || DEFAULT_DIM) || DEFAULT_DIM,
    ollama: (process.env.MEM_VECTOR_OLLAMA || DEFAULT_OLLAMA).replace(/\/+$/, ''),
    collection: DEFAULT_COLLECTION,
    queryPrefix,
    docPrefix: process.env.MEM_VECTOR_DOC_PREFIX ?? '',
    idleMs: Number(process.env.MEM_VECTOR_IDLE_MS || 600000) || 600000,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VectorSession {
  constructor(config) {
    this.cfg = config;
    this.child = null;
    this.transport = null;
    this.pending = new Map();
    this.seq = 0;
    this.first = true;
    this.disabled = null;
    this.softFails = 0;
    this.idleTimer = null;
    this.stderr = '';
    this.relay = null;
    this.resOffset = 0;
    this.resBuffer = '';
    this.pumping = false;
    this.starting = null;
  }

  requestConfig() {
    return {
      dir: this.cfg.dir,
      model: this.cfg.model,
      dim: this.cfg.dim,
      ollama: this.cfg.ollama,
      query_prefix: this.cfg.queryPrefix,
      doc_prefix: this.cfg.docPrefix,
      collection: this.cfg.collection,
    };
  }

  async ensureStarted() {
    if (this.disabled) throw Object.assign(new Error(this.disabled), { reason: this.disabled });
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    hookExit();
    if (!existsSync(this.cfg.python)) {
      this.disabled = 'python_missing';
      throw Object.assign(new Error('python_missing'), { reason: 'python_missing' });
    }
    if (!existsSync(this.cfg.worker)) {
      this.disabled = 'worker_missing';
      throw Object.assign(new Error('worker_missing'), { reason: 'worker_missing' });
    }
    try {
      this.startPipe();
      return;
    } catch {
      // 沙箱/受限环境不允许开匿名管道（Windows 上是 EPERM），退回文件中继
    }
    try {
      await this.startRelay();
    } catch (err) {
      this.disabled = 'spawn_failed';
      throw Object.assign(new Error(`spawn_failed: ${err?.message || err}`), { reason: 'spawn_failed' });
    }
  }

  startPipe() {
    const child = spawn(this.cfg.python, ['-u', this.cfg.worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    // 不把 worker 的管道算进事件循环：父进程该退就退，退出钩子里同步 kill
    child.unref?.();
    child.stdin?.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    // worker 死掉时管道会 EPIPE；不接住会当成未捕获异常把宿主进程带走
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.on('error', (err) => this.failAll(`worker_error:${err?.code || 'unknown'}`));
    child.on('exit', () => {
      this.child = null;
      this.failAll('worker_exited');
    });
    this.child = child;
    this.transport = 'pipe';
  }

  async startRelay() {
    const stamp = `${process.pid}-${Date.now()}`;
    const relayDir = path.join(this.cfg.dir, '.relay', stamp);
    await fs.mkdir(relayDir, { recursive: true });
    const req = path.join(relayDir, 'req.ndjson');
    const res = path.join(relayDir, 'res.ndjson');
    const log = path.join(relayDir, 'log.txt');
    await fs.writeFile(req, '');
    await fs.writeFile(res, '');
    await fs.writeFile(log, '');
    const child = spawn(
      this.cfg.python,
      ['-u', this.cfg.worker, '--relay', req, res, '--log', log, '--idle-ms', String(this.cfg.idleMs)],
      { stdio: 'ignore', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
    );
    child.unref?.();
    child.on('error', () => { this.child = null; this.failAll('worker_exited'); });
    child.on('exit', () => { this.child = null; this.failAll('worker_exited'); });
    this.child = child;
    this.transport = 'relay';
    this.relay = { dir: relayDir, req, res, log };
    this.resOffset = 0;
    this.resBuffer = '';
  }

  async send(line) {
    if (this.transport === 'pipe') {
      if (!this.child?.stdin?.writable) throw new Error('worker 管道不可写');
      this.child.stdin.write(`${line}\n`);
      return;
    }
    if (!this.relay) throw new Error('worker 中继未就绪');
    await fs.appendFile(this.relay.req, `${line}\n`);
    void this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.size > 0 && this.relay) {
        await this.drain();
        if (this.pending.size === 0) break;
        await sleep(POLL_MS);
      }
    } finally {
      this.pumping = false;
    }
  }

  async drain() {
    const res = this.relay?.res;
    if (!res) return;
    let stat;
    try {
      stat = await fs.stat(res);
    } catch {
      return;
    }
    if (stat.size <= this.resOffset) return;
    const length = stat.size - this.resOffset;
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(res, 'r');
    try {
      await handle.read(buffer, 0, length, this.resOffset);
    } finally {
      await handle.close();
    }
    if (length > 0) this.resOffset += length;
    this.resBuffer += buffer.toString('utf8');
    let index;
    while ((index = this.resBuffer.indexOf('\n')) >= 0) {
      const line = this.resBuffer.slice(0, index);
      this.resBuffer = this.resBuffer.slice(index + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    this.first = false;
    this.armIdle();
    entry.resolve(message);
  }

  armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.cfg.idleMs) return;
    this.idleTimer = setTimeout(() => { void this.stop(); }, this.cfg.idleMs);
    this.idleTimer.unref?.();
  }

  failAll(reason) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, reason, id });
    }
  }

  request(op, payload = {}, { timeoutMs = null, onTimeout = 'stop' } = {}) {
    return (async () => {
      try {
        await this.ensureStarted();
      } catch (err) {
        return { ok: false, reason: this.disabled || err?.reason || 'unavailable', detail: String(err?.message || err) };
      }
      const id = ++this.seq;
      const budget = Number(timeoutMs) || (this.first ? FIRST_TIMEOUT_MS : OP_TIMEOUT_MS);
      // detach：写链路的增量同步用。超时只放弃本轮，不 softFail、不杀 worker，
      // 否则后台同步会把正在服务 recall 的 worker 杀掉，甚至把向量通道整体禁用。
      const detach = onTimeout === 'detach';
      const promise = new Promise((resolve) => {
        const entry = { resolve, timer: null };
        this.pending.set(id, entry);
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          resolve({ ok: false, reason: 'timeout', op, id, detail: `${budget}ms 内无响应` });
          if (detach) {
            this.armIdle();
            return;
          }
          this.softFail('timeout');
          void this.stop();
        }, budget);
      });
      try {
        await this.send(JSON.stringify({ id, op, ...payload, config: this.requestConfig() }));
      } catch (err) {
        const entry = this.pending.get(id);
        if (!entry) return promise;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        this.softFail('send_failed');
        entry.resolve({ ok: false, reason: 'send_failed', op, id, detail: String(err?.message || err) });
        void this.stop();
      }
      return promise;
    })();
  }

  softFail(reason) {
    this.softFails += 1;
    if (this.softFails >= 2) this.disabled = reason;
  }

  /** 硬失败（元数据/条数不对等）本进程内直接关掉，避免每条召回都白跑一次 */
  applyReason(reason) {
    if (reason && HARD_REASONS.has(reason)) {
      this.disabled = reason;
      void this.stop();
    }
    if (!reason) this.softFails = 0;
  }

  async stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', resolve);
        // 这个兜底计时器必须 ref：父进程要等到子进程真的退出才能删中继文件
        setTimeout(resolve, 300);
      });
      try {
        child.kill();
      } catch {
        /* 已经死了就忽略 */
      }
      await exited;
    }
    const relay = this.relay;
    this.relay = null;
    this.transport = null;
    this.failAll('stopped');
    if (relay) {
      // Windows 上子进程刚退出时句柄可能还没释放，重试几次再放弃
      let removed = false;
      for (let attempt = 0; attempt < 4 && !removed; attempt++) {
        try {
          await fs.rm(relay.dir, { recursive: true, force: true });
          removed = true;
        } catch {
          await sleep(60);
        }
      }
      if (removed) {
        try {
          await fs.rmdir(path.dirname(relay.dir));
        } catch {
          /* 还有别的会话在用就算了 */
        }
      }
    }
  }

  killSync() {
    const child = this.child;
    if (!child) return;
    if (this.relay) {
      // 中继模式没有 EOF 可依赖，退出前同步写一条 shutdown，让 worker 自己收尾
      try {
        appendFileSync(this.relay.req, `${JSON.stringify({ id: 0, op: 'shutdown' })}\n`);
      } catch {
        /* 忽略 */
      }
    }
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }

  info() {
    return {
      running: Boolean(this.child),
      transport: this.transport,
      disabled: this.disabled,
      dir: this.cfg.dir,
      model: this.cfg.model,
    };
  }
}

function sessionKey(config) {
  return `${config.dir}|${config.model}|${config.collection}|${config.python}|${config.worker}`;
}

function getSession(config) {
  const key = sessionKey(config);
  let session = sessions.get(key);
  if (!session) {
    session = new VectorSession(config);
    sessions.set(key, session);
  }
  return session;
}

/** 丢掉某个目录（或全部）的 worker；rebuild 之后必须调，否则旧的 disabled 状态会残留 */
export async function resetVectorWorkers({ dir = null } = {}) {
  for (const [key, session] of [...sessions]) {
    if (dir && path.resolve(session.cfg.dir) !== path.resolve(dir)) continue;
    sessions.delete(key);
    await session.stop();
  }
}

export async function closeVectorWorkers() {
  await resetVectorWorkers({});
}

export function vectorSessionInfo({ dbPath = null, dir = null } = {}) {
  const config = vectorConfig({ dbPath, dir });
  const session = sessions.get(sessionKey(config));
  return session ? session.info() : { running: false, transport: null, disabled: null, dir: config.dir, model: config.model };
}

function wrap(response, config, session = null) {
  return {
    ...response,
    dir: config.dir,
    model: config.model,
    transport: session ? session.info().transport : null,
  };
}

export async function vectorQuery({
  dbPath = null, dir = null, text = '', n = 30, statuses = ['active'],
  expectedCount = null, mode = null, timeoutMs = null,
} = {}) {
  const resolved = vectorMode(mode);
  if (resolved === 'off') return { ok: false, reason: 'off', dir: dir || null };
  const config = vectorConfig({ dbPath, dir });
  if (resolved === 'auto' && !existsSync(config.python)) {
    return { ok: false, reason: 'python_missing', dir: config.dir, model: config.model };
  }
  const session = getSession(config);
  const response = await session.request('query', {
    text: String(text ?? ''),
    n: Number(n) || 30,
    statuses: [...(statuses || [])],
    expected_count: expectedCount == null ? null : Number(expectedCount),
  }, { timeoutMs });
  session.applyReason(response.reason);
  return wrap(response, config, session);
}

export async function vectorUpsert({ dbPath = null, dir = null, notes = [], mode = null, timeoutMs = null } = {}) {
  const resolved = vectorMode(mode);
  if (resolved === 'off') return { ok: false, reason: 'off' };
  const config = vectorConfig({ dbPath, dir });
  if (resolved === 'auto' && !existsSync(config.python)) return { ok: false, reason: 'python_missing', dir: config.dir };
  const session = getSession(config);
  const response = await session.request('upsert', { notes }, { timeoutMs: timeoutMs ?? REBUILD_TIMEOUT_MS });
  session.applyReason(response.reason);
  return wrap(response, config, session);
}

export async function vectorStat({ dbPath = null, dir = null, mode = null } = {}) {
  const resolved = vectorMode(mode);
  if (resolved === 'off') return { ok: false, reason: 'off' };
  const config = vectorConfig({ dbPath, dir });
  if (resolved === 'auto' && !existsSync(config.python)) return { ok: false, reason: 'python_missing', dir: config.dir };
  const session = getSession(config);
  const response = await session.request('stat', {});
  session.applyReason(response.reason);
  return wrap(response, config, session);
}

export async function vectorWarmup({ dbPath = null, dir = null, mode = null, timeoutMs = 30000 } = {}) {
  const resolved = vectorMode(mode);
  if (resolved === 'off') return { ok: false, reason: 'off' };
  const config = vectorConfig({ dbPath, dir });
  if (resolved === 'auto' && !existsSync(config.python)) return { ok: false, reason: 'python_missing', dir: config.dir };
  const session = getSession(config);
  const response = await session.request('warmup', {}, { timeoutMs });
  session.applyReason(response.reason);
  return wrap(response, config, session);
}

/** 把整条笔记摊成 worker 要的形状：一条笔记一个 chunk，id 与 FTS 相同 */
export function notePayload(row) {
  return {
    id: String(row.id),
    text: `${row.title || ''}\n${row.body || ''}`,
    path: String(row.path || ''),
    title: String(row.title || ''),
    channel: Number(row.channel) || 0,
    status: String(row.status || 'active'),
    updated_at: String(row.updated_at || ''),
    // 与 FTS 侧同一指纹：增量同步后可用它核对 collection 是否落后于索引
    doc_hash: String(row.doc_hash || ''),
  };
}

/** 索引库 → 向量库全量同步（--rebuild / eval / maintain 用；增量同步见 syncNotesToVector） */
export async function syncIndexToVector({ dbPath, dir = null, mode = null, timeoutMs = null } = {}) {
  const resolved = vectorMode(mode);
  if (resolved === 'off') return { ok: false, reason: 'off' };
  const config = vectorConfig({ dbPath, dir });
  if (resolved === 'auto' && !existsSync(config.python)) {
    return { ok: false, reason: 'python_missing', dir: config.dir, model: config.model };
  }
  const db = openIndex(dbPath);
  let notes;
  try {
    const ids = db.prepare('select id from notes order by path').all().map((row) => row.id);
    notes = getNotesByIds(db, ids).map(notePayload);
  } finally {
    closeIndex(db);
  }
  await resetVectorWorkers({ dir: config.dir });
  const session = getSession(config);
  const response = await session.request('rebuild', { notes }, { timeoutMs: timeoutMs ?? REBUILD_TIMEOUT_MS });
  session.applyReason(response.reason);
  return { ...wrap({ ...response, notes: notes.length }, config, session), notes: notes.length };
}

// ---------------------------------------------------------------- 增量同步（写链路）

// 最近一次增量同步的结果；写链路是 fire-and-forget，失败只靠 trace 与这个快照留痕
let lastSync = null;
let syncAttempts = 0;
let syncFailures = 0;

function recordSync(result) {
  syncAttempts += 1;
  if (!result.ok) syncFailures += 1;
  lastSync = {
    at: new Date().toISOString(),
    ok: Boolean(result.ok),
    reason: result.reason ?? null,
    ids: Number(result.ids) || 0,
    found: Number(result.found) || 0,
    written: Number(result.written) || 0,
    failed: Number(result.failed) || 0,
    ms: Number(result.ms) || 0,
    dir: result.dir ?? null,
    mode: result.mode ?? null,
  };
  return lastSync;
}

/** 最近一次增量同步的快照（tests/诊断用）；纯读，不启动 worker */
export function syncStatus() {
  return {
    ...(lastSync || {
      at: null, ok: null, reason: 'none', ids: 0, found: 0,
      written: 0, failed: 0, ms: 0, dir: null, mode: null,
    }),
    attempts: syncAttempts,
    failures: syncFailures,
  };
}

/**
 * 按 id 从索引库取整行 → 逐条 upsert 到向量库；id/document/metadata 与全量 rebuild 同源。
 * 空 ids 直接返回，不碰 worker；任何失败都返回 ok:false（不抛）。
 * timeoutMs 是整轮总预算：写链路 2s，超时就放弃本轮，等下一条写入或下次维护补。
 */
export async function syncNotesToVector({ dbPath, dir = null, ids = [], mode = null, timeoutMs = null } = {}) {
  const t0 = Date.now();
  const wanted = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!wanted.length) {
    return { ok: true, reason: 'empty', ids: 0, found: 0, written: 0, failed: 0, ms: 0, dir: dir ? path.resolve(String(dir)) : null };
  }
  const resolved = vectorMode(mode);
  if (resolved === 'off') {
    return recordSync({ ok: false, reason: 'off', ids: wanted.length, ms: Date.now() - t0, mode: resolved });
  }
  const config = vectorConfig({ dbPath, dir });
  if (resolved === 'auto' && !existsSync(config.python)) {
    return recordSync({
      ok: false, reason: 'python_missing', ids: wanted.length, ms: Date.now() - t0,
      dir: config.dir, mode: resolved,
    });
  }
  let notes = [];
  try {
    const db = openIndex(dbPath);
    try {
      notes = getNotesByIds(db, wanted).map(notePayload);
    } finally {
      closeIndex(db);
    }
  } catch (err) {
    return recordSync({
      ok: false, reason: 'db_error', ids: wanted.length, ms: Date.now() - t0,
      dir: config.dir, mode: resolved,
    });
  }
  if (!notes.length) {
    return recordSync({
      ok: false, reason: 'not_found', ids: wanted.length, ms: Date.now() - t0,
      dir: config.dir, mode: resolved,
    });
  }

  const budget = Number(timeoutMs) || SYNC_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const session = getSession(config);
  let written = 0;
  let lastReason = null;
  for (const note of notes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastReason = 'timeout';
      break;
    }
    const response = await session.request('upsert', { notes: [note] }, {
      timeoutMs: remaining, onTimeout: 'detach',
    });
    session.applyReason(response.reason);
    if (!response.ok) {
      lastReason = response.reason || 'sync_failed';
      break;
    }
    written += Number(response.written) || 1;
  }
  const ok = lastReason === null;
  return recordSync({
    ok, reason: ok ? null : lastReason, ids: wanted.length, found: notes.length,
    written, failed: notes.length - written, ms: Date.now() - t0,
    dir: config.dir, mode: resolved,
  });
}
