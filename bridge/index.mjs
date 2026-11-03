// bridge/index.mjs — SQLite + FTS5（trigram）派生索引。
// 定位：可丢弃、可重建，只服务检索，不作证据。中文查询 <3 字走 LIKE 兜底（实验二结论）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { walkMarkdown, readNote, CHANNEL } from './vault.mjs';

export const SCHEMA_VERSION = 1;

const DDL = `
create table if not exists notes (
  id           text primary key,
  path         text not null unique,
  dir          text not null default '',
  title        text not null default '',
  body         text not null default '',
  tags         text not null default '',
  aliases      text not null default '',
  memory_kind  text,
  status       text not null default 'active',
  source       text,
  sensitivity  text,
  channel      integer not null default 0,
  recorded_at  text,
  occurred_at  text,
  updated_at   text,
  mtime_ms     integer,
  size         integer,
  doc_hash     text
);
create virtual table if not exists notes_fts using fts5(
  id unindexed, title, body, aliases, tags, tokenize='trigram'
);
create table if not exists meta (key text primary key, value text);
`;

const FIELDS = [
  'id', 'path', 'dir', 'title', 'body', 'tags', 'aliases', 'memory_kind', 'status',
  'source', 'sensitivity', 'channel', 'recorded_at', 'occurred_at', 'updated_at',
  'mtime_ms', 'size', 'doc_hash',
];

const INSERT = `insert into notes (${FIELDS.join(', ')}) values (${FIELDS.map(() => '?').join(', ')})`;

function ensureSchema(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v === SCHEMA_VERSION) return;
  db.exec('DROP TABLE IF EXISTS notes');
  db.exec('DROP TABLE IF EXISTS notes_fts');
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function openIndex(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 3000');
  ensureSchema(db);
  return db;
}

export function closeIndex(db) {
  try {
    db.close();
  } catch {
    /* 已关就忽略 */
  }
}

function rowOf(note) {
  const m = note.meta || {};
  const mtime = Number(note.mtimeMs) || Date.now();
  return {
    id: note.id,
    path: note.path,
    dir: note.dir || '',
    title: note.title || '',
    body: note.body || '',
    tags: (m.tags || []).join('\n'),
    aliases: (m.aliases || []).join('\n'),
    memory_kind: m.memory_kind ?? null,
    status: String(note.status || m.status || 'active'),
    source: note.source ?? (m.source == null ? null : String(m.source)),
    sensitivity: m.sensitivity == null ? null : String(m.sensitivity),
    channel: Number(note.channel ?? CHANNEL[note.dir] ?? 0),
    recorded_at: m.recorded_at == null ? null : String(m.recorded_at),
    occurred_at: m.occurred_at == null ? null : String(m.occurred_at),
    updated_at: String(m.updated_at || m.recorded_at || new Date(mtime).toISOString()),
    mtime_ms: note.mtimeMs ?? null,
    size: note.size ?? null,
    doc_hash: note.docHash ?? null,
  };
}

/** 单条写入：以 id 为身份，路径变化只更新映射，不产生重复行 */
export function upsertNote(db, note) {
  const r = rowOf(note);
  db.prepare('delete from notes where path = ? and id <> ?').run(r.path, r.id);
  db.prepare('delete from notes where id = ?').run(r.id);
  db.prepare(INSERT).run(...FIELDS.map((f) => r[f]));
  db.prepare('delete from notes_fts where id = ?').run(r.id);
  db.prepare('insert into notes_fts (id, title, body, aliases, tags) values (?, ?, ?, ?, ?)')
    .run(r.id, r.title, r.body, r.aliases, r.tags);
  db.prepare("insert into meta (key, value) values ('indexed_at', ?) on conflict(key) do update set value = excluded.value")
    .run(new Date().toISOString());
  return r;
}

export function removeNote(db, id) {
  db.prepare('delete from notes where id = ?').run(id);
  db.prepare('delete from notes_fts where id = ?').run(id);
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败就让原错误上抛 */
    }
    throw err;
  }
}

/** 全量重建：扫 Vault → 清空 → 重写索引；消失的笔记记 tombstones（软删除信号） */
export async function rebuildIndex(dbPath, vaultDir, { tombstonesPath = null } = {}) {
  const t0 = Date.now();
  const db = openIndex(dbPath);
  const prev = db.prepare('select id, path from notes').all().map((r) => ({ id: r.id, path: r.path }));
  const rels = await walkMarkdown(vaultDir);
  const notes = [];
  for (const rel of rels) notes.push(await readNote(vaultDir, rel));

  tx(db, () => {
    db.exec('delete from notes');
    db.exec('delete from notes_fts');
    for (const note of notes) upsertNote(db, note);
  });

  const ids = new Set(notes.map((n) => n.id));
  const paths = new Set(notes.map((n) => n.path));
  const removed = prev.filter((p) => !ids.has(p.id) && !paths.has(p.path));
  if (tombstonesPath && removed.length) {
    await fs.mkdir(path.dirname(tombstonesPath), { recursive: true });
    const at = new Date().toISOString();
    const lines = removed.map((p) => JSON.stringify({ at, event: 'missing_on_rebuild', id: p.id, path: p.path }));
    await fs.appendFile(tombstonesPath, `${lines.join('\n')}\n`, 'utf8');
  }
  return {
    db,
    stats: { notes: notes.length, scanned: rels.length, removed, ms: Date.now() - t0 },
  };
}

const ESC = "like ? escape '\\'";

function likeParam(term) {
  return `%${String(term).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 候选检索：≥3 字走 FTS5 trigram，<3 字走 LIKE 兜底，两路取并集交给上层排序。
 * 只返回候选行，不在这里做业务排序与裁剪。
 */
export function searchIndex(db, terms, { statuses = ['active'], limit = 120 } = {}) {
  const all = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
  const long = all.filter((t) => t.length >= 3);
  const short = all.filter((t) => t.length < 3);
  const statusSql = statuses.length ? ` and n.status in (${statuses.map(() => '?').join(', ')})` : '';
  const rows = [];
  const channels = { fts: 0, like: 0, long, short };

  if (long.length) {
    const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const sql = `select n.*, bm25(notes_fts) as fts_rank
      from notes_fts join notes n on n.id = notes_fts.id
      where notes_fts match ?${statusSql}
      order by fts_rank limit ?`;
    const got = db.prepare(sql).all(match, ...statuses, limit);
    channels.fts = got.length;
    rows.push(...got);
  }

  if (short.length) {
    const clause = short.map(() => `(n.title ${ESC} or n.aliases ${ESC} or n.body ${ESC})`).join(' or ');
    const params = short.flatMap((t) => [likeParam(t), likeParam(t), likeParam(t)]);
    const sql = `select n.* from notes n
      where (${clause})${statusSql}
      order by n.channel desc, n.updated_at desc limit ?`;
    const got = db.prepare(sql).all(...params, ...statuses, limit * 3);
    channels.like = got.length;
    rows.push(...got);
  }

  const seen = new Set();
  const merged = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return { rows: merged, channels };
}

/** 按 id 批量取整行（向量命中回填用）；顺序跟随传入的 ids，库里没有的直接跳过 */
export function getNotesByIds(db, ids) {
  const wanted = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(', ');
  const rows = db.prepare(`select * from notes where id in (${placeholders})`).all(...wanted);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return wanted.map((id) => byId.get(id)).filter(Boolean);
}

/** 单条笔记写索引：重建失败/缺失时先建库 */
export async function indexNote({ vaultDir, dbPath, rel }) {
  const { db } = await ensureIndex({ vaultDir, dbPath });
  try {
    upsertNote(db, await readNote(vaultDir, rel));
  } finally {
    closeIndex(db);
  }
}

/** 缺索引就建；不自动每次重建（重建走 rebuild） */
export async function ensureIndex({ vaultDir, dbPath }) {
  const db = openIndex(dbPath);
  const stats = indexStats(db);
  if (stats.notes > 0) return { db, rebuilt: false, stats };
  closeIndex(db);
  const { db: fresh, stats: rebuilt } = await rebuildIndex(dbPath, vaultDir);
  return { db: fresh, rebuilt: true, stats: rebuilt };
}

/** 别名表：active 笔记的 aliases 用于查询展开 */
export function loadEntities(db) {
  return db.prepare("select id, path, title, aliases from notes where status = 'active'").all()
    .map((r) => ({
      id: r.id,
      path: r.path,
      title: String(r.title || ''),
      aliases: String(r.aliases || '').split('\n').map((s) => s.trim()).filter(Boolean),
    }));
}

export function indexStats(db) {
  const notes = db.prepare('select count(*) as n from notes').get().n;
  const byStatus = {};
  for (const r of db.prepare('select status, count(*) as n from notes group by status').all()) {
    byStatus[r.status] = r.n;
  }
  const last = db.prepare("select value from meta where key = 'indexed_at'").get();
  return { notes, byStatus, indexedAt: last ? last.value : null };
}
