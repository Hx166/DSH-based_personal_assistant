#!/usr/bin/env node
// deploy/smoke.mjs — 升级后冒烟：握手、列工具、跑一次 recall。
// 用法：node deploy/smoke.mjs [--vault DIR] [--runtime DIR] [--index FILE] ["查询"]
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
const positional = [];
const query = arg('query', positional[0] || '考研');

process.env.MEM_VAULT = path.resolve(arg('vault', process.env.MEM_VAULT || path.join(PROJECT, 'vault')));
process.env.MEM_RUNTIME = path.resolve(arg('runtime', process.env.MEM_RUNTIME || path.join(PROJECT, 'runtime')));
process.env.MEM_INDEX = path.resolve(arg('index', process.env.MEM_INDEX || path.join(process.env.MEM_RUNTIME, 'index.db')));

const { handleMessage } = await import('../server.mjs');

const rpc = (id, method, params) => handleMessage({ jsonrpc: '2.0', id, method, params });
const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.1' } });
const list = await rpc(2, 'tools/list');
const call = await rpc(3, 'tools/call', { name: 'recall', arguments: { query } });
const status = await rpc(4, 'tools/call', { name: 'status', arguments: {} });

const tools = (list?.result?.tools || []).map((t) => t.name);
const recallText = call?.result?.content?.[0]?.text || '';
const statusText = status?.result?.content?.[0]?.text || '';

const checks = [
  ['initialize', init?.result?.serverInfo?.name === 'memory-vault'],
  ['tools/list 含 recall/write/confirm/status', ['recall', 'write', 'confirm', 'status'].every((n) => tools.includes(n))],
  ['recall 返回文本', recallText.length > 0],
  ['status 可读', statusText.includes('"notes"')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
console.log(`\n工具：${tools.join('、') || '（无）'}`);
console.log(`Vault：${process.env.MEM_VAULT}`);
console.log(`recall(${query}) → ${recallText.replace(/\s+/g, ' ').slice(0, 120)}${recallText.length > 120 ? '…' : ''}`);
process.exitCode = failed ? 1 : 0;
