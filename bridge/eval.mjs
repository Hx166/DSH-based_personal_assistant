#!/usr/bin/env node
// bridge/eval.mjs — 检索层评测：golden/v1.jsonl × 两种模式（仅 FTS5 / FTS+向量+RRF）。
//
// 口径：
//   recall@3 = 返回 items 前 3 条的 path 是否命中该题 evidence 里的任一条。
//   T5 是拒答题、evidence 为空，按 evidence 命中算必然是 0，属口径问题不是失败：
//     → T5 单独列一栏标 N/A，不计入合计；合计只统计 T1–T4、T6（17 条）。
//     → 同时打印「含 T5 的 20 条口径」作参考。
//
// 不写 trace、不读简报；临时 db 与向量目录都在 runtime/tmp/eval，跑完保留供核对。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import { recall } from '../bridge/recall.mjs';
import { syncIndexToVector, closeVectorWorkers, vectorMode } from '../bridge/vector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const GOLDEN = path.join(ACTION, 'golden', 'v1.jsonl');
const FIXTURE = path.join(ACTION, 'test', 'fixtures', 'vault');
const EVAL_ROOT = path.resolve(ACTION, '..', 'runtime', 'tmp', 'eval');

const GROUPS = [
  ['T1', '事实'],
  ['T2', '更新'],
  ['T3', '时间'],
  ['T4', '多跳'],
  ['T5', '拒答'],
  ['T6', '干扰'],
];
const SCORED_GROUPS = new Set(['T1', 'T2', 'T3', 'T4', 'T6']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) opts[key] = inline;
    else if (!argv[i + 1] || argv[i + 1].startsWith('--')) opts[key] = true;
    else opts[key] = argv[++i];
  }
  return opts;
}

async function loadGolden() {
  const text = await fs.readFile(GOLDEN, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const meta = lines.find((row) => row._meta) || {};
  const cases = lines.filter((row) => !row._meta);
  return { meta, cases };
}

function groupOf(id) {
  return String(id || '').split('-')[0];
}

async function runMode({ cases, vaultDir, dbPath, vector, vectorDir, maxDistance }) {
  const runs = [];
  for (const item of cases) {
    const result = await recall(item.query, {
      vaultDir,
      dbPath,
      vector,
      vectorDir,
      vectorMaxDistance: maxDistance,
    });
    runs.push({
      id: item.id,
      query: item.query,
      top3: result.items.slice(0, 3).map((entry) => entry.path),
      paths: result.items.map((entry) => entry.path),
      ms: result.ms,
      vector: result.channels?.vector || null,
    });
  }
  return runs;
}

function scoreGroup(cases, runs) {
  const group = new Map();
  for (const item of cases) {
    const key = groupOf(item.id);
    const evidence = (item.evidence || []).filter(Boolean);
    if (!group.has(key)) {
      group.set(key, { id: key, asked: 0, hits: 0, total: 0, na: true, cases: [] });
    }
    const stat = group.get(key);
    stat.total += 1;
    if (!evidence.length) {
      // 拒答题：没有证据页，recall@3 不适用
      stat.cases.push({ id: item.id, na: true });
      continue;
    }
    stat.na = false;
    stat.asked += 1;
    const run = runs.find((entry) => entry.id === item.id);
    const hit = Boolean(run && run.top3.some((p) => evidence.includes(p)));
    if (hit) stat.hits += 1;
    stat.cases.push({
      id: item.id,
      hit,
      expected: evidence,
      got: run ? run.top3 : [],
      query: item.query,
    });
  }
  return group;
}

function summarize(cases, runs) {
  const group = scoreGroup(cases, runs);
  const groups = GROUPS.map(([id, label]) => {
    const stat = group.get(id) || { id, asked: 0, hits: 0, total: 0, na: true, cases: [] };
    return { id, label, asked: stat.asked, hits: stat.hits, total: stat.total, na: stat.na, cases: stat.cases };
  });
  const scored = groups.filter((entry) => SCORED_GROUPS.has(entry.id));
  const total = scored.reduce((acc, entry) => acc + entry.asked, 0);
  const hits = scored.reduce((acc, entry) => acc + entry.hits, 0);
  const naGroups = groups.filter((entry) => !SCORED_GROUPS.has(entry.id));
  const naAsked = naGroups.reduce((acc, entry) => acc + entry.total, 0);
  const naHits = naGroups.reduce((acc, entry) => acc + entry.hits, 0);
  const meanMs = runs.length ? Math.round(runs.reduce((acc, entry) => acc + (entry.ms || 0), 0) / runs.length) : 0;
  return {
    groups,
    total,
    hits,
    naAsked,
    naHits,
    meanMs,
    all: { asked: total + naAsked, hits: hits + naHits },
  };
}

function vectorReport(sync, runs) {
  const infos = runs.map((entry) => entry.vector).filter(Boolean);
  const used = infos.filter((info) => info.used).length;
  const reason = infos.find((info) => !info.used && info.reason)?.reason
    || sync?.reason
    || 'unknown';
  const ok = runs.length > 0 && used === runs.length;
  const first = infos.find((info) => info.used) || null;
  return {
    ok,
    reason: ok ? null : reason,
    used,
    cases: runs.length,
    count: first?.count ?? sync?.count ?? null,
    model: sync?.model || null,
    transport: sync?.transport || null,
    max_distance: first?.max_distance ?? null,
    k: first?.k ?? null,
    mean_ms: first?.ms ?? sync?.ms ?? null,
  };
}

function fmtRatio(stat) {
  if (!stat || stat.na || !stat.asked) return 'N/A（拒答，无证据）';
  return `${stat.hits}/${stat.asked}`;
}

function printTable({ fts, vec, vectorInfo, meta, paths }) {
  const lines = [];
  lines.push(`# 检索层评测（golden ${meta.version || 'v1'}）`);
  lines.push('');
  lines.push(`- 语料：\`${paths.corpus}\`（${meta.count ?? '?'} 条）`);
  lines.push(`- 临时库：\`${paths.db}\``);
  lines.push(`- 向量库：\`${paths.vectorDir}\``);
  if (vectorInfo.ok) {
    lines.push(`- 向量侧：可用；model=\`${vectorInfo.model}\`，collection ${vectorInfo.count ?? '?'} 条，间距阈值 ${vectorInfo.max_distance}，RRF k=${vectorInfo.k}，传输 ${vectorInfo.transport || '?'}`);
  } else {
    lines.push(`- 向量侧：**不可用（${vectorInfo.reason}）**；第二列与第一列同源，实际仍是纯 FTS5`);
  }
  lines.push('');
  lines.push('| 组 | 类型 | 仅 FTS5 | FTS+向量+RRF |');
  lines.push('| --- | --- | --- | --- |');
  for (const group of fts.groups) {
    if (!SCORED_GROUPS.has(group.id)) continue;
    const vecGroup = vec?.groups.find((entry) => entry.id === group.id);
    lines.push(`| ${group.id} | ${group.label} | ${fmtRatio(group)} | ${vec ? fmtRatio(vecGroup) : '—（降级为 FTS）'} |`);
  }
  lines.push(`| **合计（T1–T4、T6）** | 17 题 | **${fts.hits}/${fts.total}** | ${vec ? `**${vec.hits}/${vec.total}**` : '—（降级为 FTS）'} |`);
  const refuse = fts.groups.find((entry) => entry.id === 'T5');
  lines.push(`| T5 | 拒答（不计入合计） | N/A（拒答，无证据） | N/A（拒答，无证据） |`);
  lines.push('');
  if (vec) {
    lines.push(`含 T5 的 20 条口径（T5 按 0 计，仅作参考）：仅 FTS5 ${fts.all.hits}/${fts.all.asked}；FTS+向量+RRF ${vec.all.hits}/${vec.all.asked}（其中 T5 ${refuse?.total ?? 0} 题无证据）`);
  } else {
    lines.push(`含 T5 的 20 条口径（T5 按 0 计，仅作参考）：仅 FTS5 ${fts.all.hits}/${fts.all.asked}；FTS+向量+RRF 不可用（T5 ${refuse?.total ?? 0} 题无证据）`);
  }
  lines.push('');
  lines.push(`平均耗时：仅 FTS5 ${fts.meanMs}ms/题${vec ? `；FTS+向量+RRF ${vec.meanMs}ms/题` : ''}`);

  const misses = [];
  for (const group of fts.groups) {
    for (const item of group.cases) {
      if (item.na) continue;
      if (!item.hit) misses.push(`  - [FTS5] ${item.id}「${item.query}」返回 ${item.got.join('、') || '（空）'}，期望 ${item.expected.join('、')}`);
    }
  }
  if (vec) {
    for (const group of vec.groups) {
      for (const item of group.cases) {
        if (item.na) continue;
        if (!item.hit) misses.push(`  - [FTS+向量] ${item.id}「${item.query}」返回 ${item.got.join('、') || '（空）'}，期望 ${item.expected.join('、')}`);
      }
    }
  }
  if (misses.length) {
    lines.push('');
    lines.push('漏召：');
    lines.push(...misses);
  }
  console.log(lines.join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const vaultDir = path.resolve(String(opts.vault || FIXTURE));
  const maxDistance = Number(opts['max-distance'] || 0.35);
  await fs.rm(EVAL_ROOT, { recursive: true, force: true });
  await fs.mkdir(EVAL_ROOT, { recursive: true });
  const dbPath = path.resolve(String(opts.db || path.join(EVAL_ROOT, 'index.db')));
  const vectorDir = path.resolve(String(opts['vector-dir'] || path.join(EVAL_ROOT, 'vector')));

  const { meta, cases } = await loadGolden();
  let exitCode = 0;
  try {
    const { db, stats } = await rebuildIndex(dbPath, vaultDir, {
      tombstonesPath: path.join(EVAL_ROOT, 'tombstones.jsonl'),
    });
    closeIndex(db);
    if (!opts.json) console.error(`[eval] 索引重建：${stats.notes} 条 / ${stats.ms}ms`);

    const ftsRuns = await runMode({
      cases, vaultDir, dbPath, vector: 'off', vectorDir, maxDistance,
    });
    const fts = summarize(cases, ftsRuns);

    let vecRuns = null;
    let vec = null;
    let sync = null;
    const wantVector = vectorMode() !== 'off';
    if (wantVector) {
      sync = await syncIndexToVector({ dbPath, dir: vectorDir, mode: 'on' });
      if (!opts.json) {
        console.error(sync.ok
          ? `[eval] 向量库重建：${sync.count} 条 / ${sync.ms}ms`
          : `[eval] 向量库不可用：${sync.reason}（降级为纯 FTS5）`);
      }
      if (sync.ok) {
        vecRuns = await runMode({
          cases, vaultDir, dbPath, vector: 'on', vectorDir, maxDistance,
        });
        vec = summarize(cases, vecRuns);
      }
    } else {
      sync = { ok: false, reason: 'off' };
    }
    const vectorInfo = vectorReport(sync, vecRuns || []);

    const payload = {
      generated_at: new Date().toISOString(),
      golden: meta.version || 'v1',
      corpus: vaultDir,
      corpus_hash: meta.corpus_hash || null,
      threshold: maxDistance,
      paths: { db: dbPath, vector_dir: vectorDir },
      vector: vectorInfo,
      groups: fts.groups.map((group) => {
        const other = vec?.groups.find((entry) => entry.id === group.id) || null;
        return {
          id: group.id,
          label: group.label,
          scored: SCORED_GROUPS.has(group.id),
          fts: group.na ? null : { hits: group.hits, asked: group.asked },
          vector: other && !other.na ? { hits: other.hits, asked: other.asked } : null,
        };
      }),
      totals: {
        fts: { hits: fts.hits, asked: fts.total },
        vector: vec ? { hits: vec.hits, asked: vec.total } : null,
        with_t5: {
          fts: { hits: fts.all.hits, asked: fts.all.asked },
          vector: vec ? { hits: vec.all.hits, asked: vec.all.asked } : null,
        },
      },
      cases: cases.map((item) => {
        const ftsRun = ftsRuns.find((entry) => entry.id === item.id);
        const vecRun = (vecRuns || []).find((entry) => entry.id === item.id) || null;
        return {
          id: item.id,
          type: item.type || null,
          query: item.query,
          evidence: item.evidence || [],
          fts_top3: ftsRun?.top3 || [],
          vector_top3: vecRun?.top3 || null,
          vector_used: Boolean(vecRun?.vector?.used),
        };
      }),
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printTable({
        fts,
        vec,
        vectorInfo,
        meta,
        paths: { corpus: vaultDir, db: dbPath, vectorDir },
      });
    }
    return payload;
  } catch (err) {
    console.error(err?.stack || String(err));
    exitCode = 1;
    return null;
  } finally {
    await closeVectorWorkers();
    if (exitCode) process.exitCode = exitCode;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}

export { main, summarize, parseArgs };
