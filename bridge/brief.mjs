// bridge/brief.mjs — 状态简报：六段式、覆盖写、磁盘版本为基线；每次写入前留一份历史快照。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isoLocal } from './capture.mjs';

export const SECTIONS = [
  ['target', '目标'],
  ['decided', '已定'],
  ['doing', '进行中'],
  ['blockers', '阻塞'],
  ['next', '下一步'],
  ['files', '相关文件'],
];

const MAX_HISTORY = 20;

export function briefPath(runtimeDir) {
  return path.join(runtimeDir, 'management', 'brief.md');
}

export function emptyBrief() {
  return { target: '', decided: [], doing: [], blockers: [], next: [], files: [] };
}

export function renderBrief(sections, now = new Date()) {
  const lines = ['# 状态简报', '', `更新：${isoLocal(now)}`, ''];
  for (const [key, title] of SECTIONS) {
    lines.push(`## ${title}`);
    const value = sections[key];
    if (Array.isArray(value)) {
      if (!value.length) lines.push('（无）');
      else for (const item of value) lines.push(`- ${item}`);
    } else {
      lines.push(value ? String(value) : '（无）');
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function parseBrief(text) {
  const out = emptyBrief();
  for (const part of String(text).split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const title = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1);
    const entry = SECTIONS.find(([, t]) => t === title);
    if (!entry) continue;
    const key = entry[0];
    if (key === 'target') {
      const line = body.trim();
      out.target = line === '（无）' ? '' : line;
      continue;
    }
    out[key] = body.split('\n')
      .map((l) => l.replace(/^-\s*/, '').trim())
      .filter((l) => l && l !== '（无）');
  }
  return out;
}

export async function readBrief({ runtimeDir }) {
  const file = briefPath(runtimeDir);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return { path: file, exists: true, raw, sections: parseBrief(raw) };
  } catch {
    return { path: file, exists: false, raw: '', sections: emptyBrief() };
  }
}

/**
 * 覆盖写：只替换 patch 里出现的段，其余段保留。
 * 历史快照进 runtime/management/brief-history/，保留最近 20 份。
 */
export async function writeBrief({ runtimeDir, patch = {}, now = new Date() }) {
  const current = await readBrief({ runtimeDir });
  const next = { ...current.sections };
  for (const [key] of SECTIONS) {
    if (patch[key] === undefined) continue;
    const value = patch[key];
    if (key === 'target') {
      next.target = value == null ? '' : String(value).trim();
    } else if (Array.isArray(value)) {
      next[key] = value.map((s) => String(s).trim()).filter(Boolean);
    } else {
      next[key] = String(value ?? '').split('\n').map((s) => s.replace(/^-\s*/, '').trim()).filter(Boolean);
    }
  }

  const file = briefPath(runtimeDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (current.exists) {
    const dir = path.join(runtimeDir, 'management', 'brief-history');
    const stamp = isoLocal(now).replace(/[:T]/g, '-').slice(0, 16);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${stamp}-${randomBytes(2).toString('hex')}.md`), current.raw, 'utf8');
    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - MAX_HISTORY))) {
      await fs.unlink(path.join(dir, old));
    }
  }

  const raw = renderBrief(next, now);
  await fs.writeFile(file, raw, 'utf8');
  return { path: file, sections: next, raw };
}
