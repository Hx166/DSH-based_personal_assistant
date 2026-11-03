#!/usr/bin/env node
// test/brief-pin.test.mjs — 阶段 C：状态简报置顶（第 0 条，单独预算 800，总上限 3200）。
// 1) 简报存在时固定第 0 条，<memory> 里也排最前
// 2) 不占 3/2/1 通道配额：事实仍 3 条，正文与关掉简报时逐字一致
// 3) 超长简报截断（≤800，带 …）；总注入 ≤3200
// 4) 简报缺失 / 空文件：行为与关掉简报完全一致
// 5) --no-brief 关闭；channels.brief 统计
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import {
  recall, briefExcerpt, BRIEF_BUDGET, TOTAL_BUDGET, BRIEF_PATH,
} from '../bridge/recall.mjs';
import { main as recallMain } from '../bridge/recall-cli.mjs';
import { writeBrief } from '../bridge/brief.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'vault');
const TMP = path.resolve(ACTION, '..', 'runtime', 'tmp', 'brief-pin');
const VAULT = path.join(TMP, 'vault');
const DB = path.join(TMP, 'index.db');
const RUNTIME = path.join(TMP, 'runtime');
const MISSING = path.join(TMP, 'runtime-missing');
const BLANK = path.join(TMP, 'runtime-blank');
const LONG = path.join(TMP, 'runtime-long');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const counts = (run) => {
  const out = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const item of run.items) out[item.channel] = (out[item.channel] || 0) + 1;
  return out;
};
const bodyOf = (run) => run.items.filter((item) => item.channel !== 0);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });
await fs.cp(FIXTURE, VAULT, { recursive: true });
const { db } = await rebuildIndex(DB, VAULT);
closeIndex(db);

// 六段齐全的简报
await writeBrief({
  runtimeDir: RUNTIME,
  patch: {
    target: '把状态简报置顶到召回第 0 条',
    decided: ['简报单独预算 800，总上限 3200'],
    doing: ['写 stage C 的测试'],
    blockers: ['真实 runtime 里已经有一份简报'],
    next: ['跑 npm test 与 eval'],
    files: ['bridge/recall.mjs', 'test/brief-pin.test.mjs'],
  },
});

// 超长简报：一条 3000+ 字的六段文本
const longLines = ['# 状态简报', '', '更新：2026-11-03T22:00:00+08:00', ''];
for (let i = 0; i < 8; i++) {
  longLines.push(`## 段${i}`, `- ${'很长的简报条目'.repeat(60)}`, '');
}
const longRaw = longLines.join('\n');
await fs.mkdir(path.join(LONG, 'management'), { recursive: true });
await fs.writeFile(path.join(LONG, 'management', 'brief.md'), longRaw, 'utf8');

// 空简报文件
await fs.mkdir(path.join(BLANK, 'management'), { recursive: true });
await fs.writeFile(path.join(BLANK, 'management', 'brief.md'), '', 'utf8');

// ---- 1) 置顶与标签
const withBrief = await recall('考研', { vaultDir: VAULT, dbPath: DB, runtimeDir: RUNTIME });
const zero = withBrief.items[0] || {};
check('简报固定第 0 条（id/path/title/channel/status/source/score）',
  zero.id === 'brief' && zero.path === BRIEF_PATH && zero.title === '状态简报'
  && zero.channel === 0 && zero.status === 'active' && zero.source === 'user' && zero.score === 1,
  `${zero.id || '(空)'} / ${zero.path || '(空)'} / channel=${zero.channel} / score=${zero.score}`);
check('简报只出现一次（不重复）',
  withBrief.items.filter((item) => item.id === 'brief').length === 1
  && withBrief.items.filter((item) => item.channel === 0).length === 1,
  `id=brief ${withBrief.items.filter((item) => item.id === 'brief').length} 条`);

const lines = withBrief.text.split('\n');
check('text 里简报排最前且带 [简报] 标签',
  lines[0] === '<memory>' && lines[2].startsWith('[简报]')
  && withBrief.text.includes(`[简报][用户陈述][来源:${BRIEF_PATH}]`)
  && withBrief.text.indexOf('[简报]') < withBrief.text.indexOf('[事实]'),
  `第 3 行开头：${lines[2]?.slice(0, 24) || '(空)'}`);
check('简报正文非空（六段压成一行）',
  typeof zero.excerpt === 'string' && zero.excerpt.includes('状态简报')
  && zero.excerpt.includes('跑 npm test 与 eval'), `${zero.excerpt?.length || 0} 字`);

// ---- 2) 不占通道配额：与关掉简报逐字一致
const off = await recall('考研', { vaultDir: VAULT, dbPath: DB, runtimeDir: RUNTIME, brief: false });
const withCounts = counts(withBrief);
const offCounts = counts(off);
check('不占通道配额：事实仍 3 条，2/1 通道不变',
  withCounts[3] === 3 && offCounts[3] === 3
  && withCounts[1] === offCounts[1] && withCounts[2] === offCounts[2],
  `事实 ${withCounts[3]}/${offCounts[3]}，记录 ${withCounts[2]}/${offCounts[2]}，索引 ${withCounts[1]}/${offCounts[1]}`);
check('正文一字不减（简报另算预算）',
  sameJson(bodyOf(withBrief), off.items)
  && withBrief.items.length === off.items.length + 1,
  `正文 ${off.items.length} 条，注入 ${withBrief.chars - off.chars} 字给简报`);
check('总字符 = 正文 + 简报，且 ≤3200',
  withBrief.chars === off.chars + withBrief.channels.brief.chars && withBrief.chars <= TOTAL_BUDGET,
  `${withBrief.chars} = ${off.chars} + ${withBrief.channels.brief.chars} ≤ ${TOTAL_BUDGET}`);
check('channels.brief 统计',
  withBrief.channels.brief.used === true && withBrief.channels.brief.reason === null
  && withBrief.channels.brief.budget === BRIEF_BUDGET
  && withBrief.channels.brief.total_budget === TOTAL_BUDGET,
  `budget=${withBrief.channels.brief.budget} total=${withBrief.channels.brief.total_budget}`);

// ---- 3) 不参与 topic 门槛：查询与简报内容无关也照样第 0 条
const unrelated = await recall('数学', { vaultDir: VAULT, dbPath: DB, runtimeDir: RUNTIME });
check('简报不参与 topic 门槛（无关查询仍在第 0 条）',
  unrelated.items[0]?.id === 'brief' && unrelated.items.some((item) => item.channel === 3),
  `第 0 条 ${unrelated.items[0]?.id || '(空)'}`);

// ---- 4) 超长截断
const longRun = await recall('考研', { vaultDir: VAULT, dbPath: DB, runtimeDir: LONG });
const longBrief = longRun.items[0] || {};
check('超长简报截断到 ≤800 且补 …',
  longBrief.id === 'brief' && longBrief.excerpt.length <= BRIEF_BUDGET
  && longBrief.excerpt.endsWith('…') && longRun.channels.brief.truncated === true,
  `excerpt=${longBrief.excerpt.length} 字 / 原文压平 ${longRaw.length} 字`);
check('截断后总注入仍 ≤3200、事实仍 3 条',
  longRun.chars <= TOTAL_BUDGET && counts(longRun)[3] === 3,
  `${longRun.chars} 字符 / 事实 ${counts(longRun)[3]} 条`);
check('briefBudget 可调（200 字）',
  (await recall('考研', {
    vaultDir: VAULT, dbPath: DB, runtimeDir: RUNTIME, briefBudget: 200,
  })).items[0]?.excerpt.length <= 200);
check('简报预算调大也要守住总上限 3200',
  (await recall('考研', {
    vaultDir: VAULT, dbPath: DB, runtimeDir: LONG, briefBudget: 4000,
  })).chars <= TOTAL_BUDGET);

// ---- 5) 缺失 / 空文件：与关掉简报完全一致
const missing = await recall('考研', { vaultDir: VAULT, dbPath: DB, runtimeDir: MISSING });
check('简报缺失时行为与关掉一致',
  missing.channels.brief.used === false && missing.channels.brief.reason === 'missing'
  && missing.text === off.text && sameJson(missing.items, off.items),
  `reason=${missing.channels.brief.reason}`);
const blank = await recall('考研', { vaultDir: VAULT, dbPath: DB, runtimeDir: BLANK });
check('简报为空文件时行为与关掉一致',
  blank.channels.brief.used === false && blank.channels.brief.reason === 'empty'
  && blank.text === off.text && sameJson(blank.items, off.items),
  `reason=${blank.channels.brief.reason}`);

// ---- 6) --no-brief
const outFile = path.join(TMP, 'cli-nobrief.json');
await recallMain(['--vault', VAULT, '--db', DB, '--out', outFile, '--no-brief', '考研']);
const cli = JSON.parse(await fs.readFile(outFile, 'utf8'));
check('--no-brief 关闭简报',
  cli.channels.brief.used === false && cli.channels.brief.reason === 'off'
  && !cli.items.some((item) => item.channel === 0) && !cli.text.includes('[简报]'),
  `reason=${cli.channels.brief.reason}`);

// ---- 7) 纯函数：简报压平与截断
check('briefExcerpt 压成一行、去 # 并截断',
  briefExcerpt(`# 状态简报\n\n## 目标\n- ${'甲'.repeat(900)}`, 800).length === 800
  && !briefExcerpt('# 状态简报\n\n## 目标\n- 内容', 800).includes('\n')
  && briefExcerpt('# 标题\n\n内容', 800).startsWith('标题'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败项：${failed.map((f) => f.name).join('；')}`);
  process.exitCode = 1;
}
