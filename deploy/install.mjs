#!/usr/bin/env node
// deploy/install.mjs — 把记忆桥条目合并进 DSH profile 的 cordis.patch.yml。
// 先备份、写 manifest、失败不留半截；重复安装会被拒绝。配置里一律绝对路径。
// 用法：node deploy/install.mjs [--patch FILE] [--server FILE] [--vault DIR] [--index FILE] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const PROJECT = path.resolve(ACTION, '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const dryRun = argv.includes('--dry-run');

const patchFile = path.resolve(arg('patch', path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')));
const serverFile = path.resolve(arg('server', path.join(ACTION, 'server.mjs')));
const vaultDir = path.resolve(arg('vault', path.join(PROJECT, 'vault')));
const indexFile = path.resolve(arg('index', path.join(PROJECT, 'runtime', 'index.db')));
const ENTRY_ID = 'memory-vault';
const fwd = (p) => p.replace(/\\/g, '/');

if (!fs.existsSync(serverFile)) throw new Error(`server.mjs 不存在：${serverFile}`);
if (!fs.existsSync(vaultDir)) throw new Error(`Vault 目录不存在：${vaultDir}`);

const template = fs.readFileSync(path.join(HERE, 'mcp.patch.yml'), 'utf8');
const block = `${template
  .replaceAll('{{SERVER}}', fwd(serverFile))
  .replaceAll('{{VAULT}}', fwd(vaultDir))
  .replaceAll('{{INDEX}}', fwd(indexFile))
  .trimEnd()}\n`;

if (dryRun) {
  console.log(block);
  process.exit(0);
}

if (!fs.existsSync(patchFile)) throw new Error(`profile 配置不存在：${patchFile}`);
const original = fs.readFileSync(patchFile, 'utf8');
if (original.includes(`id: ${ENTRY_ID}`)) {
  throw new Error(`条目 ${ENTRY_ID} 已存在；先跑 node deploy/rollback.mjs`);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${patchFile}.bak-${stamp}`;
fs.copyFileSync(patchFile, backup);

const next = `${original.replace(/\s*$/, '\n')}\n${block}`;
fs.writeFileSync(patchFile, next, 'utf8');
if (!fs.readFileSync(patchFile, 'utf8').includes(`id: ${ENTRY_ID}`)) {
  fs.copyFileSync(backup, patchFile);
  throw new Error('写入后校验失败，已从备份恢复');
}

fs.mkdirSync(path.join(PROJECT, 'runtime', 'backups'), { recursive: true });
const manifest = {
  installed_at: new Date().toISOString(),
  entry_id: ENTRY_ID,
  server_name: 'memory',
  patch: fwd(patchFile),
  backup: fwd(backup),
  server: fwd(serverFile),
  vault: fwd(vaultDir),
  index: fwd(indexFile),
  node: process.version,
};
fs.writeFileSync(path.join(HERE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`patched=${manifest.patch}`);
console.log(`backup=${manifest.backup}`);
console.log(`manifest=${fwd(path.join(HERE, 'manifest.json'))}`);
console.log('next: 重启 DSH，然后在新会话里看工具名 mcp__memory__recall；冒烟跑 node deploy/smoke.mjs');
