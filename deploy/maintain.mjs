#!/usr/bin/env node
// deploy/maintain.mjs — 每日维护：draft 超期清理 → 索引全量重建 → Vault zip 快照。
// 用法：node deploy/maintain.mjs [--vault DIR] [--runtime DIR] [--index FILE] [--keep-days 7] [--no-backup]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expireDrafts } from '../bridge/confirm.mjs';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import { backupVault } from './backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const vaultDir = path.resolve(arg('vault', process.env.MEM_VAULT || path.join(PROJECT, 'vault')));
const runtimeDir = path.resolve(arg('runtime', process.env.MEM_RUNTIME || path.join(PROJECT, 'runtime')));
const dbPath = path.resolve(arg('index', process.env.MEM_INDEX || path.join(runtimeDir, 'index.db')));
const keepDays = Number(arg('keep-days', 7));

const expired = await expireDrafts({
  vaultDir,
  dbPath,
  days: 30,
  now: new Date(),
});

const { db, stats } = await rebuildIndex(dbPath, vaultDir, {
  tombstonesPath: path.join(runtimeDir, 'management', 'tombstones.jsonl'),
});
closeIndex(db);

const backup = argv.includes('--no-backup')
  ? null
  : await backupVault({ vaultDir, outDir: path.join(runtimeDir, 'backups'), keepDays });

console.log(JSON.stringify({
  at: new Date().toISOString(),
  expired_drafts: expired,
  index: { notes: stats.notes, removed: stats.removed.length, ms: stats.ms },
  backup,
}, null, 2));
