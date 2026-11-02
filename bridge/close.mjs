// bridge/close.mjs — 会话收尾三分类：留 → capture；缓 → 状态简报；丢 → 只计数。
// 分类本身由模型给出（见 AGENTS.md），这里只做落盘与校验。
import { capture, isoLocal } from './capture.mjs';
import { writeBrief } from './brief.mjs';
import { appendTrace } from './trace.mjs';

/**
 * @param keep   [{ text, title?, aliases?, kind?, user_verbatim?, source?, supersedes?, force? }]
 * @param brief  { target?, decided?, doing?, blockers?, next?, files? } 或 null
 * @param dropped 丢弃条数（只进 trace，不落库）
 */
export async function closeSession({
  vaultDir, dbPath, runtimeDir, keep = [], brief = null, dropped = 0, now = new Date(),
}) {
  const kept = [];
  for (const item of Array.isArray(keep) ? keep : []) {
    if (!item || !String(item.text || '').trim()) continue;
    const result = await capture({
      vaultDir,
      dbPath,
      text: String(item.text),
      title: String(item.title || ''),
      aliases: item.aliases || [],
      kind: item.kind === 'event' ? 'event' : item.kind === 'thought' ? 'thought' : 'fact',
      source: item.user_verbatim ? 'user' : item.source === 'external' ? 'external' : 'assistant',
      sourcePath: item.source_path ? String(item.source_path) : null,
      supersedes: item.supersedes ? String(item.supersedes) : null,
      force: Boolean(item.force),
      now,
    });
    kept.push({
      action: result.action,
      id: result.id || null,
      path: result.path || null,
      status: result.status || null,
      preview: String(item.text).replace(/\s+/g, ' ').slice(0, 40),
    });
  }

  const written = brief ? await writeBrief({ runtimeDir, patch: brief, now }) : null;
  const created = kept.filter((k) => k.action !== 'duplicate').length;
  await appendTrace(runtimeDir, {
    at: isoLocal(now),
    source: 'close',
    kept: created,
    duplicates: kept.length - created,
    dropped: Number(dropped) || 0,
    brief: Boolean(written),
  });
  return {
    kept, created, duplicates: kept.length - created, dropped: Number(dropped) || 0,
    brief: written ? { path: written.path, sections: written.sections } : null,
  };
}
