#!/usr/bin/env node
// deploy/maintain.mjs — 每日维护：draft 超期清理 → 索引全量重建 → 向量全量重建 → Vault zip 快照。
// 用法：node deploy/maintain.mjs [--vault DIR] [--runtime DIR] [--index FILE] [--keep-days 7] [--no-backup]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expireDrafts } from '../bridge/confirm.mjs';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import { syncIndexToVector, vectorMode } from '../bridge/vector.mjs';
import { backupVault } from './backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

/**
 * 索引重建后把向量库同步成同一批笔记。
 * 向量只是加速器：MEM_VECTOR=off 跳过，任何失败只报 failed，不中断维护。
 */
async function rebuildVector({ dbPath, mode = null }) {
  const resolved = vectorMode(mode);
  if (resolved === 'off') return { status: 'skipped', reason: 'off', line: 'skipped' };
  const started = Date.now();
  try {
    const synced = await syncIndexToVector({ dbPath, dir: null, mode: resolved });
    const ms = Number(synced.ms) || Date.now() - started;
    if (synced.ok) {
      const notes = Number(synced.notes) || 0;
      return { status: 'rebuilt', notes, ms, line: `rebuilt ${notes}` };
    }
    return { status: 'failed', reason: synced.reason || 'failed', ms, line: 'failed' };
  } catch (err) {
    return { status: 'failed', reason: String(err?.message || err), ms: Date.now() - started, line: 'failed' };
  }
}

export async function runMaintain({
  vaultDir = path.resolve(process.env.MEM_VAULT || path.join(PROJECT, 'vault')),
  runtimeDir = path.resolve(process.env.MEM_RUNTIME || path.join(PROJECT, 'runtime')),
  dbPath = null,
  keepDays = 7,
  backup = true,
  mode = null,
  now = new Date(),
} = {}) {
  const resolvedDb = path.resolve(dbPath || process.env.MEM_INDEX || path.join(runtimeDir, 'index.db'));

  const expired = await expireDrafts({
    vaultDir,
    dbPath: resolvedDb,
    days: 30,
    now,
  });

  const { db, stats } = await rebuildIndex(resolvedDb, vaultDir, {
    tombstonesPath: path.join(runtimeDir, 'management', 'tombstones.jsonl'),
  });
  closeIndex(db);

  // FTS 全量重建之后，向量库用同一批行全量重建（--rebuild 也走同一条路，不重复加）
  const vector = await rebuildVector({ dbPath: resolvedDb, mode });

  const backupResult = backup
    ? await backupVault({ vaultDir, outDir: path.join(runtimeDir, 'backups'), keepDays })
    : null;

  return {
    at: new Date().toISOString(),
    expired_drafts: expired,
    index: { notes: stats.notes, removed: stats.removed.length, ms: stats.ms },
    vector,
    backup: backupResult,
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const vaultDir = path.resolve(arg('vault', process.env.MEM_VAULT || path.join(PROJECT, 'vault')));
  const runtimeDir = path.resolve(arg('runtime', process.env.MEM_RUNTIME || path.join(PROJECT, 'runtime')));
  const dbPath = path.resolve(arg('index', process.env.MEM_INDEX || path.join(runtimeDir, 'index.db')));
  const keepDays = Number(arg('keep-days', 7));

  const report = await runMaintain({
    vaultDir,
    runtimeDir,
    dbPath,
    keepDays,
    backup: !argv.includes('--no-backup'),
  });
  console.log(JSON.stringify(report, null, 2));
}
