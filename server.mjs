#!/usr/bin/env node
// server.mjs — MCP stdio 壳：协议与进程入口；工具定义与实现在 bridge/handlers.mjs。
// 工具名在 DSH 里是 mcp__memory__<tool>。
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TOOLS, createHandlers } from './bridge/handlers.mjs';
import { appendTrace } from './bridge/trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

export const VAULT = path.resolve(argOf('vault', process.env.MEM_VAULT || path.resolve(HERE, '..', 'vault')));
export const RUNTIME = path.resolve(argOf('runtime', process.env.MEM_RUNTIME || path.resolve(HERE, '..', 'runtime')));
export const DB = path.resolve(argOf('index', process.env.MEM_INDEX || path.join(RUNTIME, 'index.db')));

export const SERVER_INFO = { name: 'memory-vault', version: '0.3.0' };
export { TOOLS };

const HANDLERS = createHandlers({ vaultDir: VAULT, runtimeDir: RUNTIME, dbPath: DB });

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** 纯函数：一条 JSON-RPC 消息进，一条响应出（notification 返回 null）。测试直接调它 */
export async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'invalid request');
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = String(params?.name || '');
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const handler = HANDLERS[name];
    if (!handler) return rpcResult(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
    try {
      return rpcResult(id, await handler(args));
    } catch (err) {
      await appendTrace(RUNTIME, {
        at: new Date().toISOString(), source: 'mcp', tool: name, ok: false, error: err.message || String(err),
      });
      return rpcResult(id, { content: [{ type: 'text', text: `出错：${err.message || err}` }], isError: true });
    }
  }

  if (id === undefined) return null;
  return rpcError(id, -32601, `method not found: ${method}`);
}

/** stdio 主循环：一行一条消息，按到达顺序串行处理 */
export function start() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
        return;
      }
      const response = await handleMessage(msg);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((err) => {
      console.error(`[server] 处理失败：${err?.message || err}`);
    });
  });
  rl.on('close', () => {
    chain.finally(() => process.exit(0));
  });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) start();
