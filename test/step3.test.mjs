#!/usr/bin/env node
// test/step3.test.mjs — 状态简报、会话收尾三分类、zip 快照与保留策略。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import { writeBrief, readBrief } from '../bridge/brief.mjs';
import { closeSession } from '../bridge/close.mjs';
import { backupVault, readZipEntryCount } from '../deploy/backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'vault');
const TMP = path.resolve(ACTION, '..', 'runtime', 'tmp', 'step3');
const VAULT = path.join(TMP, 'vault');
const RUNTIME = path.join(TMP, 'runtime');
const DB = path.join(TMP, 'index.db');
const BACKUPS = path.join(TMP, 'backups');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });
await fs.cp(FIXTURE, VAULT, { recursive: true });
const rebuilt = await rebuildIndex(DB, VAULT);
closeIndex(rebuilt.db);

// 1) 简报：六段写读、单段覆盖、历史快照
const b1 = await writeBrief({
  runtimeDir: RUNTIME,
  patch: {
    target: '把记忆桥接进 DSH',
    decided: ['MCP 走内置 stdio 客户端'],
    doing: ['装 profile 条目'],
    blockers: ['需要一次重启窗口'],
    next: ['重启后看 mcp__memory__recall'],
    files: ['action/server.mjs', 'action/deploy/install.mjs'],
  },
});
const r1 = await readBrief({ runtimeDir: RUNTIME });
check('简报六段落盘', r1.exists && r1.sections.target === '把记忆桥接进 DSH' && r1.sections.files.length === 2, b1.path);
await writeBrief({
  runtimeDir: RUNTIME,
  patch: { doing: ['重启 DSH', '写 AGENTS.md'], blockers: [] },
});
const r2 = await readBrief({ runtimeDir: RUNTIME });
check('单段覆盖不影响其它段',
  r2.sections.target === r1.sections.target
  && r2.sections.decided.length === 1
  && r2.sections.doing.length === 2
  && r2.sections.blockers.length === 0,
  `doing=${r2.sections.doing.length}`);
const historyDir = path.join(RUNTIME, 'management', 'brief-history');
const history = (await fs.readdir(historyDir)).filter((f) => f.endsWith('.md'));
check('写前留历史快照', history.length === 1, `${history.length} 份`);

// 2) 收尾三分类：留 / 缓 / 丢
const closed = await closeSession({
  vaultDir: VAULT,
  dbPath: DB,
  runtimeDir: RUNTIME,
  keep: [
    { text: '我决定每天七点起床。', title: '起床时间', user_verbatim: true },
    { text: '用户可能更喜欢晚上复盘。', source: 'assistant' },
    'not-an-object',
    { text: '   ' },
  ],
  brief: { target: '把记忆桥接进 DSH', next: ['重启验证 mcp__memory__recall'], doing: ['写 AGENTS.md'] },
  dropped: 3,
});
check('留：用户原话写 active', closed.kept[0]?.status === 'active', closed.kept[0]?.path || '');
check('留：推断写 draft', closed.kept[1]?.status === 'draft', closed.kept[1]?.path || '');
check('空项与非法项被跳过', closed.kept.length === 2, `${closed.kept.length} 条`);
check('缓：简报同步更新', Boolean(closed.brief) && closed.brief.sections.next.includes('重启验证 mcp__memory__recall'));
check('丢：只计数不落库', closed.dropped === 3 && closed.created === 2, `created=${closed.created} dropped=${closed.dropped}`);

const tracesDir = path.join(RUNTIME, 'traces');
const traceFiles = (await fs.readdir(tracesDir)).filter((f) => f.endsWith('.jsonl'));
const traceLines = (await fs.readFile(path.join(tracesDir, traceFiles[0]), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const closeTrace = traceLines.find((l) => l.source === 'close');
check('收尾写 trace', Boolean(closeTrace) && closeTrace.dropped === 3 && closeTrace.kept === 2);

// 3) zip 快照：条目数、可读、保留策略
const first = await backupVault({ vaultDir: VAULT, outDir: BACKUPS, keepDays: 7 });
check('快照生成且条目数一致',
  (await fs.stat(first.file)).size > 0 && readZipEntryCount(first.file) === first.entries && first.entries > 0,
  `${first.entries} 条 / ${first.bytes} B`);

const zipBuf = await fs.readFile(first.file);
const nameLen = zipBuf.readUInt16LE(26);
const entryName = zipBuf.subarray(30, 30 + nameLen).toString('utf8');
const entrySize = zipBuf.readUInt32LE(18);
const entryData = zipBuf.subarray(30 + nameLen, 30 + nameLen + entrySize);
const original = await fs.readFile(path.join(VAULT, entryName));
check('zip 可读且内容一致',
  zipBuf.readUInt32LE(0) === 0x04034b50 && entryData.equals(original), `${entryName} / ${entrySize} B`);

const oldFile = path.join(BACKUPS, 'vault-20200101-000000.zip');
await fs.writeFile(oldFile, Buffer.from('PK'), 'utf8');
const oldTime = new Date(Date.now() - 10 * 86400000);
await fs.utimes(oldFile, oldTime, oldTime);
const second = await backupVault({ vaultDir: VAULT, outDir: BACKUPS, keepDays: 7 });
check('超过保留期的快照被清理', second.removed.includes('vault-20200101-000000.zip') && !(await fs.stat(oldFile).catch(() => null)));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败项：${failed.map((f) => f.name).join('；')}`);
  process.exitCode = 1;
}
