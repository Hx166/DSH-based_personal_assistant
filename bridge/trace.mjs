// bridge/trace.mjs — 每轮一行 JSONL，一天一个文件；写失败只告警，不影响主流程。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { maskSecrets } from './capture.mjs';

export function tracePath(runtimeDir, date = new Date()) {
  return path.join(runtimeDir, 'traces', `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** 只记事实：查询/工具/候选/注入字符/耗时；查询文本先打码。file 可覆盖日期文件名 */
export async function appendTrace(runtimeDir, record, { file = null } = {}) {
  const safe = { ...record };
  for (const key of ['query', 'text', 'error']) {
    if (typeof safe[key] === 'string') safe[key] = maskSecrets(safe[key]).text;
  }
  const target = file || tracePath(runtimeDir);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, `${JSON.stringify(safe)}\n`, 'utf8');
    return { ok: true, file: target };
  } catch (err) {
    console.error(`[trace] 写失败（忽略）: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
