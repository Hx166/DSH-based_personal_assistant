// bridge/vault.mjs — Vault（Markdown）读写层。
// 职责：扁平 frontmatter 解析/序列化、checksum、auto 区替换、目录扫描。
// 原则：文件即事实源。只在 auto 区之间写，不碰人写区与未知字段。
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SCHEMA = 1;

/** 永不进索引：Obsidian 自管区、附件、私有区、依赖 */
export const IGNORED_DIRS = new Set([
  '.obsidian', '.trash', '.git', 'node_modules', 'attachments', 'private', '_templates',
]);

/** 分区 → 召回通道（3 事实 / 2 个人记录 / 1 索引 / 0 默认不召回） */
export const CHANNEL = { facts: 3, events: 3, thoughts: 2, index: 1, history: 0, inbox: 0 };

/** 机器可写的正文标记 */
export const AUTO_MARK = { body: 'dsh:auto', index: 'dsh-index:auto' };

const ID_PREFIX = { facts: 'f', events: 'e', history: 'h', thoughts: 't', index: 'i', inbox: 'd' };

/** 序列化时的字段顺序；未列出的字段按字母序排在后面 */
const FM_ORDER = [
  'schema', 'id', 'memory_kind', 'status', 'source', 'confidence', 'sensitivity',
  'title', 'aliases', 'tags', 'recorded_at', 'occurred_at', 'valid_from', 'valid_until',
  'supersedes', 'superseded_by', 'revoked_at', 'confirmed_at', 'reason',
  'index_topic_key', 'entry_id', 'source_path', 'source_sha256', 'source_type',
  'summarized_at', 'checksum',
];

export function sha256(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/** 列表字段统一成字符串数组：支持 YAML 数组、逗号分隔、换行分隔 */
export function toList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value).split(/\s*[,，]\s*|\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || /^null$/i.test(v)) return null;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => unquote(s)).filter((s) => s !== '');
  }
  return unquote(v);
}

/** 只解析扁平字段；缩进续行（嵌套 YAML）跳过不报错，原文件保持不动 */
export function parseFrontmatter(head) {
  const data = {};
  const lines = String(head).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    if (rest.trim() === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(parseScalar(lines[++i].replace(/^\s*-\s+/, '')));
      }
      data[key] = items.length ? items : null;
    } else {
      data[key] = parseScalar(rest);
    }
  }
  return data;
}

function formatScalar(value) {
  if (value == null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s === '') return '""';
  // 带时间戳/含冒号的字符串一律加引号，避免 Obsidian 属性面板把日期转类型
  const safe = /^[\p{L}\p{N}_.\-\/ @+]+$/u.test(s)
    && !/^(true|false|null|~)$/i.test(s)
    && !/^-?\d+(\.\d+)?$/.test(s)
    && !s.endsWith(' ');
  return safe ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function stringifyFrontmatter(meta) {
  const known = FM_ORDER.filter((k) => meta[k] !== undefined);
  const rest = Object.keys(meta).filter((k) => !FM_ORDER.includes(k) && meta[k] !== undefined).sort();
  const lines = ['---'];
  for (const k of [...known, ...rest]) {
    const v = meta[k];
    lines.push(Array.isArray(v) ? `${k}: [${v.map(formatScalar).join(', ')}]` : `${k}: ${formatScalar(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function splitFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { meta: {}, body: src, hasFrontmatter: false };
  return { meta: parseFrontmatter(m[1]), body: src.slice(m[0].length), hasFrontmatter: true };
}

/** 正文归一化：去掉首尾空白，统一 LF。checksum 基于归一化正文，人只改空白不影响校验 */
export function normalizeBody(body) {
  return String(body).replace(/\r\n/g, '\n').replace(/^[\s\n]+/, '').replace(/\s+$/, '');
}

export function renderNote(meta, body) {
  return `${stringifyFrontmatter(meta)}\n\n${normalizeBody(body)}\n`;
}

/** 只换正文，frontmatter 原文（含未知字段、注释、嵌套）保留 */
function replaceBodyText(text, body) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n[\s\S]*?\n---\n?/.exec(src);
  const head = m ? m[0] : '';
  const sep = head ? (head.endsWith('\n\n') ? '' : '\n') : '';
  return `${head}${sep}${normalizeBody(body)}\n`;
}

/** 文本级改单个 frontmatter 字段：保留其它行（含嵌套/注释）不动 */
export function setFrontmatterField(text, key, value) {
  const src = String(text).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const line = `${key}: ${formatScalar(value)}`;
  if (!m) return `---\n${line}\n---\n\n${src.replace(/^\n+/, '')}`;
  const lines = m[1].split('\n');
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx >= 0) {
    let end = idx + 1;
    while (end < lines.length && /^\s+-\s+/.test(lines[end])) end++;
    lines.splice(idx, end - idx, line);
  } else {
    lines.push(line);
  }
  return `---\n${lines.join('\n')}\n---\n${src.slice(m[0].length)}`;
}

function firstHeading(body) {
  const m = /^#{1,6}\s+(.+)$/m.exec(String(body));
  return m ? m[1].trim() : '';
}

function makeId(dir, stem) {
  return `${ID_PREFIX[dir] || 'n'}-${sha256(stem).slice(0, 10)}`;
}

function normalizeMeta(raw, dir, stem) {
  const meta = { ...raw };
  meta.schema = Number(meta.schema) || SCHEMA;
  meta.id = String(meta.id || makeId(dir, stem));
  meta.aliases = toList(meta.aliases);
  meta.tags = toList(meta.tags);
  if (!meta.status) {
    meta.status = dir === 'inbox' ? 'draft' : dir === 'history' ? 'superseded' : 'active';
  }
  if (!meta.memory_kind) {
    meta.memory_kind = dir === 'index' ? 'index' : dir === 'inbox' ? 'draft' : dir === 'history' ? 'history' : 'fact';
  }
  return meta;
}

/** 列出 Vault 内所有笔记的相对路径（正斜杠），已排除忽略目录 */
export async function walkMarkdown(vaultDir, { ignored = IGNORED_DIRS } = {}) {
  const out = [];
  async function rec(abs, rel) {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ignored.has(ent.name)) continue;
        await rec(path.join(abs, ent.name), childRel);
      } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
        out.push(childRel);
      }
    }
  }
  await rec(vaultDir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function readNote(vaultDir, relPath) {
  const rel = relPath.split(path.sep).join('/');
  const absPath = path.join(vaultDir, rel);
  const text = await fs.readFile(absPath, 'utf8');
  const { meta: raw, body: rawBody } = splitFrontmatter(text);
  const body = normalizeBody(rawBody);
  const dir = rel.includes('/') ? rel.split('/')[0] : '';
  const stem = rel.split('/').pop().replace(/\.md$/i, '');
  const meta = normalizeMeta(raw, dir, stem);
  const stat = await fs.stat(absPath);
  return {
    id: meta.id, path: rel, absPath, dir, meta, body, text,
    title: String(meta.title || '').trim() || firstHeading(body) || stem,
    status: String(meta.status),
    source: meta.source == null ? null : String(meta.source),
    channel: CHANNEL[dir] ?? 0,
    docHash: sha256(text), contentHash: sha256(body),
    mtimeMs: Math.round(stat.mtimeMs), size: stat.size,
  };
}

/** checksum 是正文哈希，用于机器写前比对；人改正文会让它失配（这是信号，不是错误） */
export function checksumOf(note) {
  return sha256(note.body);
}

/** 原子写：同目录临时文件 + rename，避免半截文件 */
export async function writeNote(vaultDir, relPath, { meta, body }) {
  const rel = relPath.split(path.sep).join('/');
  const absPath = path.join(vaultDir, rel);
  const full = { ...meta };
  full.checksum = sha256(body);
  const text = renderNote(full, body);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, absPath);
  return { path: rel, text, docHash: sha256(text), contentHash: full.checksum };
}

/** 在 <!-- dsh:auto --> … <!-- /dsh:auto --> 之间替换内容 */
export function replaceAutoRegion(body, content, { marker = AUTO_MARK.body, create = false } = {}) {
  const open = `<!-- ${marker} -->`;
  const close = `<!-- /${marker} -->`;
  const s = body.indexOf(open);
  const e = s >= 0 ? body.indexOf(close, s + open.length) : -1;
  const inner = String(content).replace(/\s+$/, '');
  if (s >= 0 && e >= 0) {
    return body.slice(0, s + open.length) + `\n${inner}\n` + body.slice(e);
  }
  if (s >= 0 || e >= 0) {
    throw new Error(`auto 区标记不完整（${marker}）：保留原文件，等人工修复`);
  }
  if (!create) throw new Error(`未找到 auto 区（${marker}）：如需创建请显式 create`);
  const base = String(body).replace(/\s+$/, '');
  return `${base}\n\n${open}\n${inner}\n${close}\n`;
}

/** 只改 auto 区，人写区与未知字段原样保留；expectDocHash 不一致说明有人改过 → 抛 CONFLICT */
export async function updateAutoRegion(vaultDir, relPath, content, opts = {}) {
  const { marker = AUTO_MARK.body, create = false, expectDocHash = null, touch = true } = opts;
  const note = await readNote(vaultDir, relPath);
  if (expectDocHash && expectDocHash !== note.docHash) {
    const err = new Error(`CONFLICT: ${note.path} 在读取后被修改，请重读后再写`);
    err.code = 'CONFLICT';
    err.currentDocHash = note.docHash;
    throw err;
  }
  let bodyText = replaceAutoRegion(note.body, content, { marker, create });
  const checksum = sha256(bodyText);
  let text = replaceBodyText(note.text, bodyText);
  if (touch) text = setFrontmatterField(text, 'checksum', checksum);
  const absPath = path.join(vaultDir, note.path);
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, absPath);
  return { path: note.path, text, docHash: sha256(text) };
}

/** 换路径保留内容：先写新文件，再删旧文件；metaPatch 覆盖 frontmatter 字段 */
export async function moveNote(vaultDir, relFrom, relTo, { metaPatch = {} } = {}) {
  const note = await readNote(vaultDir, relFrom);
  const meta = { ...note.meta, ...metaPatch };
  await writeNote(vaultDir, relTo, { meta, body: note.body });
  if (relFrom !== relTo) await fs.unlink(path.join(vaultDir, relFrom));
  return { ...note, path: relTo, absPath: path.join(vaultDir, relTo), meta };
}
