#!/usr/bin/env node
// deploy/rollback.mjs — 按 manifest 恢复安装前的 cordis.patch.yml。
// 用法：node deploy/rollback.mjs [--patch FILE]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifestFile = path.join(HERE, 'manifest.json');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (!fs.existsSync(manifestFile)) throw new Error(`没有 manifest，无法回滚：${manifestFile}`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const patchFile = path.resolve(arg('patch', manifest.patch));
if (!fs.existsSync(manifest.backup)) throw new Error(`备份不存在：${manifest.backup}`);

fs.copyFileSync(manifest.backup, patchFile);
const restored = fs.readFileSync(patchFile, 'utf8');
if (restored.includes(`id: ${manifest.entry_id}`)) {
  throw new Error(`恢复后仍存在 ${manifest.entry_id}，请人工检查：${patchFile}`);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.renameSync(manifestFile, path.join(HERE, `manifest.rollback-${stamp}.json`));
console.log(`restored=${patchFile}`);
console.log(`from=${manifest.backup}`);
console.log(`entry_removed=${manifest.entry_id}`);
console.log('next: 重启 DSH 使工具列表回到安装前');
