#!/usr/bin/env node
// deploy/backup.mjs — Vault 每日 zip 快照：整个目录（含 .obsidian/ 与 attachments/），保留 N 天。
// 零依赖：自己写 ZIP（store 模式），写完读 EOCD 校验条目数。
// 用法：node deploy/backup.mjs [--vault DIR] [--out DIR] [--keep-days 7] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

function listFiles(root) {
  const out = [];
  const rec = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) rec(childAbs, childRel);
      else if (ent.isFile()) {
        const st = fs.statSync(childAbs);
        out.push({ name: childRel, abs: childAbs, mtime: st.mtime });
      }
    }
  };
  rec(root, '');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function writeZip(files, outFile) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file.abs);
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosStamp(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const zip = Buffer.concat([...parts, cdBuf, eocd]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);
  return { bytes: zip.length, entries: files.length };
}

/** 读 EOCD 里的条目数，用来确认写出来的 zip 不是半截 */
export function readZipEntryCount(file) {
  const buf = fs.readFileSync(file);
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) throw new Error('不是合法 zip：缺 EOCD');
  return buf.readUInt16LE(eocdOffset + 10);
}

function localStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function removeOld(outDir, keepDays, now) {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return [];
  const cutoff = now.getTime() - keepDays * 86400000;
  const removed = [];
  for (const name of fs.readdirSync(outDir)) {
    if (!/^vault-\d{8}-\d{6}\.zip$/.test(name)) continue;
    const file = path.join(outDir, name);
    if (fs.statSync(file).mtimeMs >= cutoff) continue;
    fs.unlinkSync(file);
    removed.push(name);
  }
  return removed;
}

export async function backupVault({ vaultDir, outDir, keepDays = 7, now = new Date(), dryRun = false }) {
  if (!fs.existsSync(vaultDir)) throw new Error(`Vault 不存在：${vaultDir}`);
  const files = listFiles(vaultDir);
  if (!files.length) throw new Error(`Vault 里没有文件：${vaultDir}`);
  const outFile = path.join(outDir, `vault-${localStamp(now)}.zip`);
  if (dryRun) return { file: outFile, entries: files.length, bytes: 0, removed: [], dryRun: true };

  const info = writeZip(files, outFile);
  const count = readZipEntryCount(outFile);
  if (count !== info.entries) throw new Error(`zip 校验失败：EOCD 记 ${count} 条，实际 ${info.entries} 条`);
  const removed = removeOld(outDir, keepDays, now);
  return { file: outFile, entries: info.entries, bytes: info.bytes, removed };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const vaultDir = path.resolve(arg('vault', process.env.MEM_VAULT || path.join(PROJECT, 'vault')));
  const outDir = path.resolve(arg('out', path.join(PROJECT, 'runtime', 'backups')));
  const keepDays = Number(arg('keep-days', 7));
  const result = await backupVault({ vaultDir, outDir, keepDays, dryRun: argv.includes('--dry-run') });
  console.log(JSON.stringify(result, null, 2));
}
