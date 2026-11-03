#!/usr/bin/env node
// test/acceptance.mjs — 第一步验收（12-新会话启动包 §4）。
// 1) 20 条样例建索引，.obsidian/attachments 不进索引
// 2) 10 条查询 hit@1 ≥8
// 3) 2 字查询不空；别名可展开
// 4) rebuild 后结果一致
// 5) draft / superseded / revoked 不进普通召回
// 6) 注入 ≤2400 字符，通道配额生效
// 7) auto 区写入不伤人写区；checksum 更新；并发冲突可检出
// 8) 命令行 recall --json 可跑
// 9) golden/v1.jsonl 证据命中率（信息项，不计入退出码）
//
// 阶段 C 起 recall 默认把状态简报置顶（channel=0）。本文件测的是 Vault 证据，
// 所有 recall 都传 brief: false 以避免受真实 runtime 简报影响；简报置顶见 brief-pin.test.mjs。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import { recall, BUDGET } from '../bridge/recall.mjs';
import { main as recallMain } from '../bridge/recall-cli.mjs';
import {
  readNote, writeNote, updateAutoRegion, checksumOf, walkMarkdown, sha256, AUTO_MARK,
} from '../bridge/vault.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'vault');
const TMP = path.resolve(ACTION, '..', 'runtime', 'tmp', 'acceptance');
const DB = path.join(TMP, 'index.db');
const t0 = Date.now();

const results = [];
function check(name, ok, detail = '', fatal = true) {
  results.push({ name, ok, fatal });
  console.log(`${ok ? 'PASS' : fatal ? 'FAIL' : 'INFO'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const A10 = [
  ['目标院校', 'facts/考研目标.md'],
  ['复习节奏', 'facts/数学复习.md'],
  ['验收要附什么', 'facts/项目验收.md'],
  ['错题本', 'facts/刷题方法.md'],
  ['时间冲突', 'facts/时间冲突.md'],
  ['导师多久发一次邮件', 'facts/导师沟通.md'],
  ['政治从什么时候开始', 'facts/政治安排.md'],
  ['报名时间', 'facts/报名时间.md'],
  ['408 四门课', 'facts/408计划.md'],
  ['英语单词每天背多少', 'facts/英语单词.md'],
];

const TWO_CHAR = ['考研', '数学', '复习', '项目', '验收'];
const HISTORY_PAGE = 'history/数学复习-旧版.md';
const REVOKED_PAGE = 'facts/院校范围-已撤回.md';

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });

  // 1) 样例与忽略目录
  const rels = await walkMarkdown(FIXTURE);
  check('样例笔记 20 条', rels.length === 20, `${rels.length} 条`);
  check('忽略 .obsidian/ 与 attachments/',
    rels.every((r) => !r.startsWith('.obsidian/') && !r.startsWith('attachments/')));

  const { db, stats } = await rebuildIndex(DB, FIXTURE, {
    tombstonesPath: path.join(TMP, 'tombstones.jsonl'),
  });
  closeIndex(db);
  check('索引重建', stats.notes === 20, `${stats.notes} 条 / ${stats.ms}ms`);

  // 2) 10 条查询 hit@1
  let hit1 = 0;
  const misses = [];
  for (const [query, want] of A10) {
    const r = await recall(query, { vaultDir: FIXTURE, dbPath: DB, brief: false });
    const got = r.items[0]?.path || '(空)';
    if (got === want) hit1 += 1;
    else misses.push(`${query} → ${got}（期望 ${want}）`);
  }
  check('10 条查询 hit@1 ≥ 8', hit1 >= 8, `${hit1}/10${misses.length ? `；漏：${misses.join('；')}` : ''}`);

  // 3) 2 字查询与别名
  const empty = [];
  for (const q of TWO_CHAR) {
    const r = await recall(q, { vaultDir: FIXTURE, dbPath: DB, brief: false });
    if (!r.items.length) empty.push(q);
  }
  check('2 字查询不空', empty.length === 0, empty.length ? `空：${empty.join('、')}` : `${TWO_CHAR.length}/${TWO_CHAR.length} 非空`);

  const alias = await recall('大创', { vaultDir: FIXTURE, dbPath: DB, brief: false });
  check('别名展开（大创 → SRTP 项目）', alias.items[0]?.path === 'facts/SRTP项目.md', alias.items[0]?.path || '(空)');

  // 4) rebuild 前后一致
  const detQueries = [...A10.map((x) => x[0]), ...TWO_CHAR, '大创', '读博', '每天三小时', '非统考院校', '导师叫什么名字'];
  const signature = async () => {
    const out = [];
    for (const q of detQueries) {
      const r = await recall(q, { vaultDir: FIXTURE, dbPath: DB, brief: false });
      out.push({ q, items: r.items.map((i) => [i.path, i.score]) });
    }
    return JSON.stringify(out);
  };
  const before = await signature();
  const second = await rebuildIndex(DB, FIXTURE);
  closeIndex(second.db);
  const after = await signature();
  check('rebuild 后结果一致', before === after, `${second.stats.notes} 条 / ${second.stats.ms}ms`);

  // 5) 状态过滤
  const draft = await recall('读博', { vaultDir: FIXTURE, dbPath: DB, brief: false });
  check('draft 不进普通召回', draft.items.length === 0, `命中 ${draft.items.length} 条`);
  const normal = await recall('每天三小时', { vaultDir: FIXTURE, dbPath: DB, brief: false });
  const normalPaths = normal.items.map((i) => i.path);
  check('superseded 页默认不召回（现行页可命中）',
    !normalPaths.includes(HISTORY_PAGE),
    normalPaths.includes(HISTORY_PAGE) ? `旧版页被召回：${HISTORY_PAGE}` : `旧版页未召回；命中现行页：${normalPaths.join('、') || '无'}`);
  const withHistory = await recall('每天三小时', { vaultDir: FIXTURE, dbPath: DB, includeHistory: true, brief: false });
  check('--history 时旧版可召回', withHistory.items.some((i) => i.path === HISTORY_PAGE));
  const revoked = await recall('非统考院校', { vaultDir: FIXTURE, dbPath: DB, brief: false });
  const revokedPaths = revoked.items.map((i) => i.path);
  check('revoked 页默认不召回（关联页可命中）',
    !revokedPaths.includes(REVOKED_PAGE),
    revokedPaths.includes(REVOKED_PAGE) ? `撤回页被召回：${REVOKED_PAGE}` : `撤回页未召回；命中关联页：${revokedPaths.join('、') || '无'}`);

  // 6) 预算与配额
  const broad = await recall('考研', { vaultDir: FIXTURE, dbPath: DB, brief: false });
  const counts = { 3: 0, 2: 0, 1: 0 };
  for (const item of broad.items) counts[item.channel] += 1;
  check('注入 ≤ 2400 字符', broad.chars <= BUDGET, `${broad.chars} 字符`);
  check('通道配额（事实≤3 / 记录≤2 / 索引≤1）',
    counts[3] <= 3 && counts[2] <= 2 && counts[1] <= 1, `事实 ${counts[3]} / 记录 ${counts[2]} / 索引 ${counts[1]}`);

  // 7) 写入路径（在副本上做，不动样例）
  const copy = path.join(TMP, 'vault');
  await fs.cp(FIXTURE, copy, { recursive: true });
  const rel = 'index/考研总览.md';
  const beforeNote = await readNote(copy, rel);
  const indexMark = { marker: AUTO_MARK.index };
  await updateAutoRegion(copy, rel, '- 目标：只报 408 统考院校\n- 数学：见 facts/数学复习.md', indexMark);
  const afterNote = await readNote(copy, rel);
  check('auto 区写入保留人写区',
    afterNote.body.includes('人写区') && afterNote.body.includes('只报 408 统考院校') && !afterNote.body.includes('408：见 facts/408计划.md'));
  check('写入后 checksum 与正文一致', afterNote.meta.checksum === checksumOf(afterNote));

  let conflict = false;
  try {
    await updateAutoRegion(copy, rel, 'x', { ...indexMark, expectDocHash: beforeNote.docHash });
  } catch (err) {
    conflict = err.code === 'CONFLICT';
  }
  check('并发冲突可检出（expectDocHash）', conflict);

  await fs.writeFile(path.join(copy, 'facts', '无标记.md'),
    '---\nschema: 1\nid: f-no-marker\nstatus: active\n---\n人写：这一页没有 auto 区\n', 'utf8');
  let refused = false;
  try {
    await updateAutoRegion(copy, 'facts/无标记.md', '机器内容');
  } catch (err) {
    refused = /未找到 auto 区/.test(err.message);
  }
  check('无 auto 区时拒绝写入（不擅自创建）', refused);
  await updateAutoRegion(copy, 'facts/无标记.md', '机器内容', { create: true });
  const created = await readNote(copy, 'facts/无标记.md');
  check('create 时新建 auto 区且保留人写', created.body.includes('人写') && created.body.includes('机器内容'));

  await writeNote(copy, 'facts/写入测试.md', {
    meta: { schema: 1, memory_kind: 'fact', status: 'active', source: 'user', recorded_at: '2026-11-02T22:00:00+08:00' },
    body: '这是一条写入测试。',
  });
  const written = await readNote(copy, 'facts/写入测试.md');
  check('新笔记写盘（schema / checksum / id）',
    written.meta.schema === 1 && written.meta.checksum === checksumOf(written) && Boolean(written.id), written.id);

  // 8) 命令行入口（进程内跑 main()，沙箱下子进程 spawn 会 EPERM）
  const outFile = path.join(TMP, 'cli.json');
  await recallMain(['--vault', FIXTURE, '--db', DB, '--out', outFile, '--no-brief', '目标院校']);
  const cli = JSON.parse(await fs.readFile(outFile, 'utf8'));
  check('命令行 recall（argv 解析 + --out）', cli.items?.[0]?.path === 'facts/考研目标.md', cli.items?.[0]?.path || '(空)');

  // 9) golden 证据命中率（信息项）
  const goldenPath = path.join(ACTION, 'golden', 'v1.jsonl');
  const lines = (await fs.readFile(goldenPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const meta = lines.find((l) => l._meta) || {};
  const cases = lines.filter((l) => !l._meta);
  const parts = [];
  for (const r of rels) parts.push(`${r}\u0000${sha256((await readNote(FIXTURE, r)).text)}`);
  const corpusHash = sha256(parts.join('\u0000'));
  check('golden 版本/corpus_hash 与样例一致', !meta.corpus_hash || corpusHash === meta.corpus_hash,
    corpusHash.slice(0, 12), false);

  let evHit = 0;
  let evTotal = 0;
  let leak = 0;
  for (const g of cases) {
    const r = await recall(g.query, { vaultDir: FIXTURE, dbPath: DB, brief: false });
    const paths = r.items.map((i) => i.path);
    if (g.evidence?.length) {
      evTotal += 1;
      if (g.evidence.some((p) => paths.includes(p))) evHit += 1;
    }
    if ((g.excluded || []).some((p) => paths.includes(p))) leak += 1;
  }
  check('golden 证据命中率 ≥ 0.8', evTotal === 0 || evHit / evTotal >= 0.8, `${evHit}/${evTotal}`, false);
  check('golden 被排除页零泄漏', leak === 0, `${leak} 次`, false);

  const failed = results.filter((r) => !r.ok && r.fatal);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过，耗时 ${Date.now() - t0}ms`);
  if (failed.length) {
    console.log(`失败项：${failed.map((f) => f.name).join('；')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
