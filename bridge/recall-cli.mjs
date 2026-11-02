// bridge/recall-cli.mjs — recall 的命令行入口（参数解析、trace、输出）。
// 业务逻辑全在 recall.mjs；这里只做 I/O，方便日后换成 MCP 壳。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { rebuildIndex, closeIndex } from './index.mjs';
import { recall, BUDGET, DEFAULT_VAULT, DEFAULT_DB, DEFAULT_RUNTIME } from './recall.mjs';
import { appendTrace } from './trace.mjs';

const BOOL = new Set(['json', 'history', 'no-alias', 'rebuild', 'explain', 'help']);

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
    else if (BOOL.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) opts[key] = true;
    else opts[key] = argv[++i];
  }
  return opts;
}

const USAGE = `用法: node bridge/recall.mjs "查询" [选项]
  --vault DIR      Vault 目录（默认 ../vault，或 MEM_VAULT）
  --db FILE        索引文件（默认 ../runtime/index.db，或 MEM_INDEX）
  --json           输出 JSON
  --out FILE       把结果 JSON 写到文件（沙箱里 spawn 无法管道取输出时用）
  --limit-chars N  本次注入预算（默认 2400）
  --history        允许召回 superseded/revoked（问"以前"时用）
  --no-alias       关闭别名展开
  --rebuild        先全量重建索引
  --explain        把候选与打分打到 stderr
  --trace FILE     追加一轮 JSONL trace（默认 runtime/traces/日期.jsonl；off 关闭）`;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const query = opts._.join(' ').trim();
  if (opts.help || !query) {
    console.error(USAGE);
    process.exitCode = opts.help ? 0 : 2;
    return;
  }
  const vaultDir = path.resolve(String(opts.vault || DEFAULT_VAULT));
  const dbPath = path.resolve(String(opts.db || DEFAULT_DB));
  const budget = Number(opts['limit-chars'] || BUDGET);

  if (opts.rebuild) {
    const { db, stats } = await rebuildIndex(dbPath, vaultDir, {
      tombstonesPath: path.join(DEFAULT_RUNTIME, 'management', 'tombstones.jsonl'),
    });
    closeIndex(db);
    if (!opts.json) console.error(`[index] rebuilt: ${stats.notes} notes, ${stats.ms}ms`);
  }

  const result = await recall(query, {
    vaultDir,
    dbPath,
    budget,
    includeHistory: Boolean(opts.history),
    expandAliases: !opts['no-alias'],
  });

  if (opts.explain) {
    console.error(`[recall] ${result.ms}ms terms=${result.terms.join('|')} expanded=${result.expanded.length} candidates=${result.candidates} chars=${result.chars}`);
    for (const item of result.items) console.error(`  ${item.score}\t${item.channel}\t${item.path}\t${item.title}`);
  }
  if (opts.trace !== 'off') {
    const file = typeof opts.trace === 'string' && opts.trace !== 'true' ? path.resolve(opts.trace) : null;
    await appendTrace(DEFAULT_RUNTIME, {
      at: new Date().toISOString(),
      source: 'cli',
      query,
      terms: result.terms,
      expanded: result.expanded.length,
      candidates: result.candidates,
      kept: result.items.map((i) => i.path),
      injected_chars: result.chars,
      ms: result.ms,
    }, { file });
  }

  if (opts.out) {
    const file = path.resolve(String(opts.out));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (result.text) process.stdout.write(`${result.text}\n`);
  else console.error('(无召回)');
  return result;
}
