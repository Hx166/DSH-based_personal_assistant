// bridge/capture.mjs — 写入管线：亲述判定、打码、摘要、查重、状态流转、文件溯源。
// 原则：只有「用户消息 + 第一人称 + 无假设词」才直接 active，其余一律 draft 进 inbox。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  readNote, writeNote, moveNote, sha256, toList,
} from './vault.mjs';
import {
  ensureIndex, closeIndex, upsertNote, searchIndex, indexNote,
} from './index.mjs';

export const MAX_SUMMARY = 800;

const HYPOTHETICAL = ['如果', '也许', '可能', '大概', '或许', '考虑', '打算', '想要', '要不要', '是否', '假设', '琢磨', '想想'];
const FIRM = ['决定', '定了', '确认', '已经', '改成', '改为', '只报', '不报', '就是'];

/** 宪法 §3：本轮用户消息 + 第一人称 + 不含假设词，三条同时满足才算亲述 */
export function judgeFirstPerson(text, { role = 'user' } = {}) {
  const t = String(text || '');
  if (role !== 'user') return { ok: false, reason: 'not_user_message' };
  if (!/我|咱/.test(t)) return { ok: false, reason: 'no_first_person' };
  const hypo = HYPOTHETICAL.find((w) => t.includes(w));
  if (hypo && !FIRM.some((w) => t.includes(w))) return { ok: false, reason: `hypothetical:${hypo}` };
  return { ok: true, reason: 'user_statement' };
}

const SECRETS = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'api_key', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'id_card', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { kind: 'bank_card', re: /(?<!\d)(?:\d[ -]?){16,19}(?!\d)/g },
  { kind: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'password', re: /(?:密码|口令|password|passwd|pwd)\s*[:：=]\s*\S+/gi },
];

/** secret 不落库：命中即整段替换为 [已打码:类别]，返回命中的类别 */
export function maskSecrets(text) {
  let out = String(text || '');
  const hits = [];
  for (const { kind, re } of SECRETS) {
    out = out.replace(re, () => {
      hits.push(kind);
      return `[已打码:${kind}]`;
    });
  }
  return { text: out, hits: [...new Set(hits)] };
}

/** 摘要 ≤800 字：超长按句号/分号断在边界，不硬切半个词 */
export function summarize(text, max = MAX_SUMMARY) {
  const flat = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const limit = max - 1;
  let cut = flat.slice(0, limit);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('\n'), cut.lastIndexOf('.'));
  if (at > limit * 0.5) cut = cut.slice(0, at + 1);
  return `${cut.trim()}…`;
}

/** 正文指纹：去空白与标点后取哈希，用于查重 */
export function fingerprint(text) {
  const norm = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return sha256(norm).slice(0, 16);
}

export function isoLocal(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function slugify(title, fallback = 'note') {
  const s = String(title || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[。，、；：！？…·“”‘’《》【】（）]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/^-|-$/g, '');
  return s || fallback;
}

/** 目标路径不存在就返回；被占用就加 -2、-3 */
export async function uniqueRel(vaultDir, dir, stem) {
  const base = slugify(stem, `note-${randomBytes(2).toString('hex')}`);
  let candidate = `${dir}/${base}.md`;
  for (let i = 2; ; i++) {
    try {
      await fs.access(path.join(vaultDir, candidate));
      candidate = `${dir}/${base}-${i}.md`;
    } catch {
      return candidate;
    }
  }
}

async function fileSha256(file) {
  const buf = await fs.readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

/** 查重：别名命中 / 标题相同 / 正文指纹相同，任一即算重复 */
export function findDuplicates(db, { title = '', body = '', aliases = [] } = {}) {
  const terms = [...toList(aliases), title].map((s) => String(s).trim()).filter(Boolean);
  const rows = terms.length
    ? searchIndex(db, terms, { statuses: ['active', 'draft'], limit: 60 }).rows
    : [];
  const fp = fingerprint(body);
  const out = new Map();
  for (const row of rows) {
    if (row.path.startsWith('history/')) continue;
    const aliasList = String(row.aliases || '').split('\n').filter(Boolean);
    const sameAlias = toList(aliases).some((a) => aliasList.includes(a));
    const sameTitle = Boolean(title) && row.title === title;
    const sameBody = fingerprint(row.body) === fp;
    if (!sameAlias && !sameTitle && !sameBody) continue;
    out.set(row.id, {
      id: row.id, path: row.path, title: row.title, status: row.status, sameAlias, sameTitle, sameBody,
    });
  }
  return [...out.values()];
}

/**
 * 写入一条记忆。返回 action=created / created+superseded / duplicate。
 * status 不接受外部指定：由 source + 亲述判定决定，杜绝"模型直接写 active"。
 */
export async function capture(opts) {
  const {
    vaultDir, dbPath, text, title = '', aliases = [], kind = 'fact',
    source = 'assistant', sensitivity = 'normal', confidence = 0.5, reason = '',
    supersedes = null, sourcePath = null, sourceSha256 = null, sourceType = null,
    force = false, now = new Date(),
  } = opts;

  const raw = String(text || '').trim();
  if (!raw) throw new Error('text 为空，拒绝写入');
  const masked = maskSecrets(raw);
  const judge = judgeFirstPerson(masked.text, { role: source === 'user' ? 'user' : 'assistant' });
  const body = summarize(masked.text);
  const status = source === 'user' && judge.ok ? 'active' : 'draft';
  const dir = status === 'draft' ? 'inbox' : kind === 'event' ? 'events' : kind === 'thought' ? 'thoughts' : 'facts';
  const memoryKind = status === 'draft' ? 'draft' : kind === 'event' ? 'event' : kind === 'thought' ? 'thought' : 'fact';

  const { db: opened } = await ensureIndex({ vaultDir, dbPath });
  let db = opened;
  try {
    const dupes = findDuplicates(db, { title, body, aliases });
    if (dupes.length && !force) return { action: 'duplicate', matches: dupes, judge, masked: masked.hits };

    const day = isoLocal(now).slice(0, 10).replace(/-/g, '');
    const prefix = kind === 'event' ? 'e' : kind === 'thought' ? 't' : 'f';
    const id = `${prefix}-${day}-${randomBytes(3).toString('hex')}`;
    const label = title || body.slice(0, 24);
    const rel = await uniqueRel(vaultDir, dir, label);

    const meta = {
      schema: 1,
      id,
      memory_kind: memoryKind,
      status,
      source,
      sensitivity,
      title: label,
      aliases: toList(aliases),
      recorded_at: isoLocal(now),
    };
    if (status === 'draft') {
      meta.confidence = Number(confidence);
      meta.reason = reason || (source === 'external' ? '外部资料摘要，待确认' : '助手推断，待确认');
      meta.proposed_kind = kind;
    }
    if (supersedes) meta.supersedes = supersedes;
    if (sourcePath) {
      meta.source_path = sourcePath;
      meta.source_type = sourceType || path.extname(sourcePath).replace('.', '') || 'unknown';
      meta.source_sha256 = sourceSha256 || await fileSha256(sourcePath);
      meta.summarized_at = isoLocal(now);
    }

    await writeNote(vaultDir, rel, { meta, body });
    upsertNote(db, await readNote(vaultDir, rel));
    const result = { id, path: rel, status, judge, masked: masked.hits, summary_chars: body.length };

    if (supersedes) {
      closeIndex(db);
      db = null;
      const old = await markSuperseded({ vaultDir, dbPath, oldId: supersedes, newId: id, now });
      return { action: 'created+superseded', ...result, superseded: old };
    }
    return { action: 'created', ...result };
  } finally {
    if (db) closeIndex(db);
  }
}

/** 旧事实置 superseded 并移入 history/；id 不变，保留时间线 */
export async function markSuperseded({ vaultDir, dbPath, oldId, newId, now = new Date() }) {
  const { db } = await ensureIndex({ vaultDir, dbPath });
  try {
    const row = db.prepare('select id, path from notes where id = ?').get(oldId);
    if (!row) throw new Error(`找不到要取代的条目：${oldId}`);
    if (!row.path.startsWith('facts/') && !row.path.startsWith('events/')) {
      throw new Error(`只能取代 facts/ 或 events/ 的条目：${row.path}`);
    }
    const note = await readNote(vaultDir, row.path);
    const target = await uniqueRel(vaultDir, 'history', path.basename(row.path, '.md'));
    const day = isoLocal(now).slice(0, 10);
    const meta = {
      ...note.meta,
      status: 'superseded',
      memory_kind: 'history',
      superseded_by: newId,
      superseded_at: isoLocal(now),
      valid_from: note.meta.valid_from || String(note.meta.recorded_at || '').slice(0, 10),
      valid_until: day,
    };
    await moveNote(vaultDir, row.path, target, { metaPatch: meta });
    await indexNote({ vaultDir, dbPath, rel: target });
    return { id: oldId, from: row.path, to: target };
  } finally {
    closeIndex(db);
  }
}
