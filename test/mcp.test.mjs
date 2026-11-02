#!/usr/bin/env node
// test/mcp.test.mjs — MCP 壳验收：握手、工具列表、recall/write/confirm/status、错误分支。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'vault');
const TMP = path.resolve(ACTION, '..', 'runtime', 'tmp', 'step2-mcp');
const VAULT = path.join(TMP, 'vault');
const DB = path.join(TMP, 'index.db');
const RUNTIME = path.join(TMP, 'runtime');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });
await fs.cp(FIXTURE, VAULT, { recursive: true });

process.env.MEM_VAULT = VAULT;
process.env.MEM_INDEX = DB;
process.env.MEM_RUNTIME = RUNTIME;

const { handleMessage } = await import('../server.mjs');
const rpc = (id, method, params) => handleMessage({ jsonrpc: '2.0', id, method, params });
const callTool = (id, name, args) => rpc(id, 'tools/call', { name, arguments: args });
const textOf = (res) => res?.result?.content?.[0]?.text ?? '';
const jsonOf = (res) => JSON.parse(textOf(res));

const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } });
check('initialize 返回 serverInfo', init?.result?.serverInfo?.name === 'memory-vault' && init?.result?.capabilities?.tools);

const list = await rpc(2, 'tools/list');
const names = (list?.result?.tools || []).map((t) => t.name);
check('tools/list 六个工具', ['recall', 'write', 'confirm', 'status', 'brief', 'close'].every((n) => names.includes(n)), names.join('、'));

const recalled = await callTool(3, 'recall', { query: '复习节奏' });
check('recall 返回 <memory> 包装', textOf(recalled).includes('<memory>') && textOf(recalled).includes('facts/数学复习.md'));

const draftWrite = await callTool(4, 'write', { text: '用户可能在考虑读博。', source: 'assistant' });
const draftJson = jsonOf(draftWrite);
check('write 默认写 draft', draftJson.status === 'draft' && String(draftJson.path).startsWith('inbox/'), draftJson.path);

const activeWrite = await callTool(5, 'write', { text: '我决定把作息改成七点起床。', user_verbatim: true });
const activeJson = jsonOf(activeWrite);
check('user_verbatim 且亲述才写 active', activeJson.status === 'active' && String(activeJson.path).startsWith('facts/'), activeJson.path);

const draftList = jsonOf(await callTool(6, 'confirm', { action: 'list' }));
check('confirm list 可读', Array.isArray(draftList.drafts) && draftList.drafts.length >= 1, `${draftList.drafts.length} 条`);

const confirmed = jsonOf(await callTool(7, 'confirm', { action: 'confirm', id: draftList.drafts[0].id }));
check('confirm 转 active', confirmed.status === 'active' && String(confirmed.path).startsWith('facts/'));

const status = jsonOf(await callTool(8, 'status', {}));
check('status 返回索引与 draft 数', status.notes > 20 && typeof status.drafts === 'number', `notes=${status.notes}`);

const briefWrite = jsonOf(await callTool(12, 'brief', {
  action: 'write',
  patch: { target: '接通 MCP', next: ['重启验证 mcp__memory__recall'] },
}));
check('brief 写入六段简报', briefWrite.sections.target === '接通 MCP' && briefWrite.sections.next.length === 1);
const briefRead = jsonOf(await callTool(13, 'brief', { action: 'read' }));
check('brief 读回一致', briefRead.exists && briefRead.sections.target === '接通 MCP');

const closed = jsonOf(await callTool(14, 'close', {
  keep: [{ text: '我决定先接 MCP 再写 AGENTS.md。', user_verbatim: true }],
  brief: { doing: ['写 AGENTS.md'] },
  dropped: 2,
}));
check('close 三分类落盘', closed.created === 1 && closed.dropped === 2 && closed.brief?.sections.doing.includes('写 AGENTS.md'));

const unknownTool = await callTool(9, 'nope', {});
check('未知工具返回 isError', unknownTool?.result?.isError === true);

const unknownMethod = await rpc(10, 'resources/list', {});
check('未知方法返回 -32601', unknownMethod?.error?.code === -32601);

const notification = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
check('notification 不返回响应', notification === null);

const emptyWrite = await callTool(11, 'write', { text: '   ' });
check('空文本写入报错', emptyWrite?.result?.isError === true, textOf(emptyWrite));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败项：${failed.map((f) => f.name).join('；')}`);
  process.exitCode = 1;
}
