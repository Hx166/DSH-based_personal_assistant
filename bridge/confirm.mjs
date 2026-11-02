// bridge/confirm.mjs — draft 队列：列表 / 确认转 active / 丢弃转 expired / 超期清理。
// 状态只能由这里改（附录 B 的确认话术落到命令行与 MCP 工具）。
import path from 'node:path';
import { readNote, moveNote, walkMarkdown } from './vault.mjs';
import { indexNote } from './index.mjs';
import { isoLocal, uniqueRel } from './capture.mjs';

async function draftsOf(vaultDir) {
  const rels = (await walkMarkdown(vaultDir)).filter((r) => r.startsWith('inbox/'));
  const out = [];
  for (const rel of rels) {
    const note = await readNote(vaultDir, rel);
    if (note.status === 'draft') out.push(note);
  }
  return out.sort((a, b) => String(a.meta.recorded_at || '').localeCompare(String(b.meta.recorded_at || '')));
}

export async function listDrafts({ vaultDir }) {
  return (await draftsOf(vaultDir)).map((n) => ({
    id: n.id,
    path: n.path,
    title: n.title,
    source: n.source,
    confidence: n.meta.confidence ?? null,
    reason: n.meta.reason ?? null,
    recorded_at: String(n.meta.recorded_at || '').slice(0, 10),
    summary: String(n.body).replace(/\s+/g, ' ').slice(0, 120),
  }));
}

async function findDraft(vaultDir, id) {
  const key = String(id || '').trim();
  if (!key) throw new Error('需要 draft 的 id');
  const all = await draftsOf(vaultDir);
  const exact = all.find((n) => n.id === key);
  if (exact) return exact;
  const partial = all.filter((n) => n.id.startsWith(key) || path.basename(n.path, '.md') === key);
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`id 不唯一：${key} 命中 ${partial.length} 条`);
  throw new Error(`找不到 draft：${key}`);
}

function directoryFor(kind) {
  if (kind === 'event') return { dir: 'events', memoryKind: 'event' };
  if (kind === 'thought') return { dir: 'thoughts', memoryKind: 'thought' };
  return { dir: 'facts', memoryKind: 'fact' };
}

/** 确认：status → active，移出 inbox，记 confirmed_at */
export async function confirmDraft({ vaultDir, dbPath, id, now = new Date() }) {
  const note = await findDraft(vaultDir, id);
  const { dir, memoryKind } = directoryFor(note.meta.proposed_kind);
  const target = await uniqueRel(vaultDir, dir, path.basename(note.path, '.md'));
  await moveNote(vaultDir, note.path, target, {
    metaPatch: { status: 'active', memory_kind: memoryKind, confirmed_at: isoLocal(now) },
  });
  await indexNote({ vaultDir, dbPath, rel: target });
  return { id: note.id, from: note.path, path: target, status: 'active' };
}

/** 丢弃：status → expired，文件留在 inbox（附录 B：文件保留） */
export async function discardDraft({ vaultDir, dbPath, id, reason = '', now = new Date() }) {
  const note = await findDraft(vaultDir, id);
  const metaPatch = { status: 'expired', expired_at: isoLocal(now) };
  if (reason) metaPatch.expired_reason = reason;
  await moveNote(vaultDir, note.path, note.path, { metaPatch });
  await indexNote({ vaultDir, dbPath, rel: note.path });
  return { id: note.id, path: note.path, status: 'expired' };
}

/** 30 天未确认自动 expired（宪法 §8）；返回被清理的 id */
export async function expireDrafts({ vaultDir, dbPath, days = 30, now = new Date() }) {
  const cutoff = now.getTime() - days * 86400000;
  const expired = [];
  for (const note of await draftsOf(vaultDir)) {
    const at = Date.parse(String(note.meta.recorded_at || ''));
    if (!Number.isFinite(at) || at > cutoff) continue;
    await moveNote(vaultDir, note.path, note.path, {
      metaPatch: { status: 'expired', expired_at: isoLocal(now), expired_reason: `${days} 天未确认` },
    });
    await indexNote({ vaultDir, dbPath, rel: note.path });
    expired.push(note.id);
  }
  return expired;
}
