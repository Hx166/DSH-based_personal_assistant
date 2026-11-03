#!/usr/bin/env node
// test/vector.test.mjs — 阶段 A（向量通道 + RRF）测试。
// 1) RRF 纯函数
// 2) 无向量输入时排序与改造前逐字节一致（FTS-only 等价）
// 3) MEM_VECTOR=off / 解释器缺失时的静默降级
// 4) 假 worker：协议、命中回填、items 字段不变
// 5) 假 worker：metadata 不一致（stale）→ 降级
// 6) 假 worker：超时 → 降级并回收
// 7) 假 worker：闲置退出
// 8) 真 chromadb（有则跑、无则跳过）：metadata 不一致、条数不一致
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  rebuildIndex, openIndex, closeIndex, searchIndex, loadEntities, getNotesByIds,
} from '../bridge/index.mjs';
import { recall, extractTerms, expandQuery, scoreTopic } from '../bridge/recall.mjs';
import { rankCandidates, rrf, DEFAULT_RRF_K } from '../bridge/fuse.mjs';
import {
  vectorQuery, vectorStat, vectorUpsert, vectorSessionInfo,
  closeVectorWorkers, resetVectorWorkers,
} from '../bridge/vector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'vault');
const FAKE_WORKER = path.join(HERE, 'fixtures', 'fake_vector_worker.py');
const TMP = path.resolve(ACTION, '..', 'runtime', 'tmp', 'vector-test');
const DB = path.join(TMP, 'index.db');
const PY = process.env.MEM_VECTOR_PY || 'D:\\Anaconda3\\envs\\ollama_ai\\python.exe';
const PY_OK = existsSync(PY);
const t0 = Date.now();

const results = [];
function check(name, ok, detail = '', fatal = true) {
  results.push({ name, ok, fatal });
  console.log(`${ok ? 'PASS' : fatal ? 'FAIL' : 'INFO'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: true, fatal: false });
  console.log(`SKIP  ${name}  — ${reason}`);
}

async function withEnv(patch, fn) {
  const prev = new Map();
  for (const [key, value] of Object.entries(patch)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeVectorWorkers();
  }
}

/** 改造前的排序（从 git 历史逐字抄下来，作为等价性基准） */
function legacyRankRows(rows, terms, { includeHistory = false } = {}) {
  const scored = [];
  for (const row of rows) {
    const channel = Number(row.channel) || (includeHistory ? 3 : 0);
    if (!channel) continue;
    const topic = scoreTopic(row, terms);
    if (topic > 0) scored.push({ row: { ...row, channel }, topic });
  }
  scored.sort((a, b) => (b.row.channel - a.row.channel)
    || (b.topic - a.topic)
    || String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || ''))
    || (a.row.path < b.row.path ? -1 : 1));
  return scored;
}

const signature = (ranked) => JSON.stringify(ranked.map((entry) => [entry.row.path, entry.topic]));

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });

  // ---- 1) RRF 纯函数
  const fused = rrf([['a', 'b', 'c'], ['b', 'c', 'd']]);
  const near = (x, y) => Math.abs(x - y) < 1e-12;
  check('rrf 分数与名次对应', near(fused.get('b'), 1 / 62 + 1 / 61)
    && near(fused.get('c'), 1 / 63 + 1 / 62)
    && near(fused.get('a'), 1 / 61), `b=${fused.get('b')?.toFixed(6)}`);
  check('rrf 排序 b > c > a > d', [...fused.entries()].sort((x, y) => y[1] - x[1]).map((x) => x[0]).join('') === 'bcad');
  check('rrf 同一列表重复 id 只算一次', near(rrf([['a', 'a', 'b']]).get('b'), 1 / 62));
  check('rrf k 可调（k=0 时首名得 1 分）', near(rrf([['a']], 0).get('a'), 1));
  check('rrf 空输入返回空 Map', rrf([]).size === 0 && rrf([[], []]).size === 0);
  check('rrf 默认 k=60', DEFAULT_RRF_K === 60);

  // ---- 索引与排序等价性
  const { db, stats } = await rebuildIndex(DB, FIXTURE);
  closeIndex(db);
  check('样例索引重建', stats.notes === 20, `${stats.notes} 条 / ${stats.ms}ms`);

  const readDb = openIndex(DB);
  const equivalence = [];
  const queries = ['目标院校', '复习节奏', '错题本', '408 第一轮', '时间冲突', '导师邮箱', '非统考院校', '两百个单词'];
  for (const query of queries) {
    const terms = expandQuery(extractTerms(query), loadEntities(readDb));
    const { rows } = searchIndex(readDb, terms, { statuses: ['active'], limit: 120 });
    const legacy = signature(legacyRankRows(rows, terms));
    const fusedNow = signature(rankCandidates(rows, { terms, scoreTopic }));
    if (legacy !== fusedNow) equivalence.push(query);
  }
  const historyTerms = expandQuery(extractTerms('每天三小时'), loadEntities(readDb));
  const historyRows = searchIndex(readDb, historyTerms, { statuses: ['active', 'superseded', 'revoked'], limit: 120 }).rows;
  const historySame = signature(legacyRankRows(historyRows, historyTerms, { includeHistory: true }))
    === signature(rankCandidates(historyRows, { terms: historyTerms, scoreTopic, includeHistory: true }));
  check('无向量时排序与改造前完全一致（8 条查询）', equivalence.length === 0,
    equivalence.length ? `不一致：${equivalence.join('、')}` : `${queries.length}/${queries.length}`);
  check('无向量时 --history 排序也一致', historySame);

  const idRows = readDb.prepare("select id from notes where status = 'active' order by path").all().map((row) => row.id);
  const byIds = getNotesByIds(readDb, [idRows[0], 'not-exist', idRows[1]]);
  check('getNotesByIds 按传入顺序返回并跳过缺失',
    byIds.length === 2 && byIds[0].id === idRows[0] && byIds[1].id === idRows[1]);

  const otherRow = readDb.prepare("select * from notes where channel = 2 and status = 'active' order by path").get();
  closeIndex(readDb);

  // ---- 3) 降级：MEM_VECTOR=off
  const baseline = await withEnv({ MEM_VECTOR: 'off' }, () => recall('目标院校', {
    vaultDir: FIXTURE, dbPath: DB, vectorDir: path.join(TMP, 'off-vector'),
  }));
  check('MEM_VECTOR=off 不启动向量通道',
    baseline.channels.vector?.used === false && baseline.channels.vector?.reason === 'off',
    `reason=${baseline.channels.vector?.reason}`);

  const missingPy = await withEnv({
    MEM_VECTOR: 'auto', MEM_VECTOR_PY: path.join(TMP, 'no-such-python.exe'),
  }, () => recall('目标院校', { vaultDir: FIXTURE, dbPath: DB, vectorDir: path.join(TMP, 'missing-py') }));
  check('解释器缺失 → 静默降级 python_missing',
    missingPy.channels.vector?.used === false && missingPy.channels.vector?.reason === 'python_missing',
    `reason=${missingPy.channels.vector?.reason}`);
  check('降级后结果与纯 FTS 一致',
    JSON.stringify(missingPy.items.map((i) => [i.path, i.score]))
      === JSON.stringify(baseline.items.map((i) => [i.path, i.score])));
  check('channels 结构保留 fts/like/long/short',
    ['fts', 'like', 'long', 'short'].every((key) => key in baseline.channels));

  // ---- 4) 假 worker：协议 + 命中回填
  const fakeDir = path.join(TMP, 'fake-vector');
  const topId = baseline.items[0]?.id;
  const fakeEnv = {
    MEM_VECTOR: 'on',
    MEM_VECTOR_PY: PY,
    MEM_VECTOR_WORKER: FAKE_WORKER,
    FAKE_COUNT: '20',
    FAKE_HITS: JSON.stringify([
      { id: topId, distance: 0.1 },
      { id: otherRow.id, distance: 0.9 },
    ]),
  };
  let fakeInfo = null;
  const fakeRun = await withEnv(fakeEnv, async () => {
    const run = await recall('目标院校', { vaultDir: FIXTURE, dbPath: DB, vectorDir: fakeDir });
    fakeInfo = vectorSessionInfo({ dbPath: DB, dir: fakeDir });
    return run;
  });
  check('假 worker：向量通道生效',
    fakeRun.channels.vector?.used === true && fakeRun.channels.vector?.hits === 2,
    `used=${fakeRun.channels.vector?.used} hits=${fakeRun.channels.vector?.hits}`);
  check('假 worker：命中参与 RRF（k=60）',
    fakeRun.channels.vector?.k === 60 && fakeRun.channels.vector?.count === 20);
  check('假 worker：词面最强项仍在首位',
    fakeRun.items[0]?.path === baseline.items[0]?.path,
    `${fakeRun.items[0]?.path || '(空)'}`);
  const keysOf = (run) => [...new Set(run.items.flatMap((item) => Object.keys(item)))].sort().join(',');
  check('items 字段与纯 FTS 完全一致（不增不删）',
    keysOf(fakeRun) === keysOf(baseline),
    keysOf(fakeRun).slice(0, 90));
  check('worker 已启动且可复用', fakeInfo?.running === true, `transport=${fakeInfo?.transport}`);

  // ---- 5) 假 worker：metadata 不一致 → 降级
  const staleRun = await withEnv({ ...fakeEnv, FAKE_REASON: 'metadata_mismatch', FAKE_STALE: '1' }, () => recall('目标院校', {
    vaultDir: FIXTURE, dbPath: DB, vectorDir: path.join(TMP, 'stale-vector'),
  }));
  check('假 worker：metadata 不一致 → stale 且降级',
    staleRun.channels.vector?.used === false
    && staleRun.channels.vector?.stale === true
    && staleRun.channels.vector?.reason === 'metadata_mismatch',
    `reason=${staleRun.channels.vector?.reason}`);
  check('stale 降级后结果与纯 FTS 一致',
    JSON.stringify(staleRun.items.map((i) => i.path)) === JSON.stringify(baseline.items.map((i) => i.path)));

  // ---- 6) 假 worker：超时 → 降级并回收
  if (PY_OK) {
    await withEnv({
      ...fakeEnv, FAKE_DELAY_MS: '3000',
    }, async () => {
      const timeoutDir = path.join(TMP, 'timeout-vector');
      const first = await vectorQuery({ dbPath: DB, dir: timeoutDir, text: 'x', timeoutMs: 250 });
      const started = Date.now();
      const second = await vectorQuery({ dbPath: DB, dir: timeoutDir, text: 'x', timeoutMs: 250 });
      const elapsed = Date.now() - started;
      check('超时 → ok:false reason=timeout',
        first.ok === false && first.reason === 'timeout', `reason=${first.reason}`);
      check('连续超时后不再反复启动 worker',
        second.ok === false && elapsed < 2000, `第二次 ${elapsed}ms / ${second.reason}`);
      check('超时后 worker 已被回收',
        vectorSessionInfo({ dbPath: DB, dir: timeoutDir }).running === false);
    });
  } else {
    skip('超时降级', '缺少测试用 Python 解释器');
  }

  // ---- 7) 假 worker：闲置退出
  if (PY_OK) {
    const idleDir = path.join(TMP, 'idle-vector');
    await withEnv({ ...fakeEnv, MEM_VECTOR_IDLE_MS: '80' }, async () => {
      const stat = await vectorStat({ dbPath: DB, dir: idleDir });
      const before = vectorSessionInfo({ dbPath: DB, dir: idleDir });
      check('空闲前 worker 在跑', stat.ok === true && before.running === true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      check('闲置到点后 worker 自动退出',
        vectorSessionInfo({ dbPath: DB, dir: idleDir }).running === false);
    });
  } else {
    skip('闲置退出', '缺少测试用 Python 解释器');
  }

  // ---- 8) 真 chromadb（可选）
  if (PY_OK) {
    await withEnv({ MEM_VECTOR: 'on', MEM_VECTOR_PY: PY, MEM_VECTOR_WORKER: undefined, MEM_VECTOR_MODEL: 'ci-model-a' }, async () => {
      const realDir = path.join(TMP, 'real-vector');
      const created = await vectorUpsert({ dbPath: DB, dir: realDir, notes: [], mode: 'on' });
      if (!created.ok) {
        skip('真 chromadb metadata 校验', `向量侧不可用：${created.reason}`);
        return;
      }
      await withEnv({ MEM_VECTOR_MODEL: 'ci-model-b' }, async () => {
        const stat = await vectorStat({ dbPath: DB, dir: realDir });
        check('真 chromadb：model 变更 → stale',
          stat.ok === true && stat.stale === true && (stat.stale_fields || []).includes('model'),
          `stale_fields=${JSON.stringify(stat.stale_fields)}`);
      });
      const otherDir = path.join(TMP, 'real-vector-count');
      const gate = await vectorQuery({ dbPath: DB, dir: otherDir, text: 'x', expectedCount: 5, mode: 'on' });
      check('真 chromadb：条数与索引不一致 → count_mismatch',
        gate.ok === false && gate.reason === 'count_mismatch', `reason=${gate.reason} count=${gate.count}`);
    });
  } else {
    skip('真 chromadb 校验', '缺少测试用 Python 解释器');
  }

  await resetVectorWorkers({});
  const failed = results.filter((entry) => !entry.ok && entry.fatal);
  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} 通过，耗时 ${Date.now() - t0}ms`);
  if (failed.length) {
    console.log(`失败项：${failed.map((entry) => entry.name).join('；')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
