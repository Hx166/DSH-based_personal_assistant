#!/usr/bin/env node
// test/capture.test.mjs — 写入管线验收：亲述判定、打码、摘要、查重、supersede、draft 流转、文件溯源。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, readNote } from '../bridge/vault.mjs';
import { rebuildIndex, closeIndex } from '../bridge/index.mjs';
import {
  capture, judgeFirstPerson, maskSecrets, summarize,
} from '../bridge/capture.mjs';
import {
  listDrafts, confirmDraft, discardDraft, expireDrafts,
} from '../bridge/confirm.mjs';
import { recall } from '../bridge/recall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'vault');
const TMP = path.resolve(ACTION, '..', 'runtime', 'tmp', 'step2-capture');
const VAULT = path.join(TMP, 'vault');
const DB = path.join(TMP, 'index.db');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });
await fs.cp(FIXTURE, VAULT, { recursive: true });
const rebuilt = await rebuildIndex(DB, VAULT);
closeIndex(rebuilt.db);

// 1) 亲述判定
check('亲述：第一人称、无假设词', judgeFirstPerson('我决定只报 408 统考院校。').ok === true);
check('非用户消息不判亲述', judgeFirstPerson('我决定只报 408 统考院校。', { role: 'assistant' }).ok === false);
check('假设词不判亲述', judgeFirstPerson('我也许会考虑读博。').ok === false);
check('假设+决断按陈述处理', judgeFirstPerson('我决定报 A 校，不过也考虑过 B 校。').ok === true);

// 2) 密钥打码
const masked = maskSecrets('我的 key 是 sk-abcdefghijklmnop12345678，手机 13812345678，身份证 110101199003071234。');
check('API key 打码', masked.text.includes('[已打码:api_key]') && !masked.text.includes('sk-abcdef'));
check('手机与身份证打码', masked.text.includes('[已打码:phone]') && masked.text.includes('[已打码:id_card]'));

// 3) 摘要上限
const longText = '复'.repeat(1200);
const shortSummary = summarize(longText);
check('摘要 ≤800 字', shortSummary.length <= 800, `${shortSummary.length} 字`);

// 4) 亲述写 active
const a = await capture({
  vaultDir: VAULT, dbPath: DB, text: '我决定每天背一百五十个单词，从明天开始。',
  title: '背单词数量', aliases: ['单词量'], source: 'user',
});
check('亲述写 active', a.action === 'created' && a.status === 'active' && a.path.startsWith('facts/'), a.path);
const aNote = await readNote(VAULT, a.path);
check('frontmatter 带别名与来源', aNote.meta.aliases.includes('单词量') && aNote.meta.source === 'user');

// 5) 推断写 draft
const b = await capture({ vaultDir: VAULT, dbPath: DB, text: '用户可能更喜欢早上学习。', source: 'assistant' });
check('助手推断写 draft', b.status === 'draft' && b.path.startsWith('inbox/'), b.path);
const bNote = await readNote(VAULT, b.path);
check('draft 带 confidence 与 reason', typeof bNote.meta.confidence === 'number' && Boolean(bNote.meta.reason));

// 6) 查重与 force
const dup = await capture({
  vaultDir: VAULT, dbPath: DB, text: '我决定每天背一百五十个单词，从明天开始。',
  title: '背单词数量', source: 'user',
});
check('查重命中', dup.action === 'duplicate' && dup.matches.length > 0, dup.matches?.[0]?.path || '');
const forced = await capture({
  vaultDir: VAULT, dbPath: DB, text: '我决定每天背一百五十个单词，从明天开始。',
  title: '背单词数量', source: 'user', force: true,
});
check('force 可强制写入', forced.action === 'created');

// 7) secret 不落盘
const secret = await capture({ vaultDir: VAULT, dbPath: DB, text: '我的 API key 是 sk-abcdefghijklmnop12345678，记住备用。', source: 'user' });
const secretRaw = await fs.readFile(path.join(VAULT, secret.path), 'utf8');
check('secret 不落盘', !secretRaw.includes('sk-abcdef') && secretRaw.includes('[已打码:api_key]'));

// 8) 文件溯源
const srcFile = path.join(TMP, '外部资料.md');
await fs.writeFile(srcFile, '外部文章：每月资料预算两百元。', 'utf8');
const fromFile = await capture({
  vaultDir: VAULT, dbPath: DB, text: '外部摘要：每月资料预算两百元。', source: 'external', sourcePath: srcFile,
});
const fromFileNote = await readNote(VAULT, fromFile.path);
check('文件溯源 source_path + sha256',
  fromFileNote.meta.source_sha256 === sha256(await fs.readFile(srcFile, 'utf8'))
  && String(fromFileNote.meta.source_path).endsWith('外部资料.md'));

// 9) supersede：旧事实移入 history/
const oldId = 'f-20261002-math-rhythm';
const replaced = await capture({
  vaultDir: VAULT, dbPath: DB, text: '我决定数学真题改成每周两套，不再隔天一套。',
  title: '数学真题频率', source: 'user', supersedes: oldId,
});
check('supersede 生效', replaced.action === 'created+superseded' && String(replaced.superseded?.to).startsWith('history/'), replaced.superseded?.to);
const oldNote = await readNote(VAULT, replaced.superseded.to);
check('旧版状态与关系', oldNote.status === 'superseded' && oldNote.meta.superseded_by === replaced.id && Boolean(oldNote.meta.valid_until));
let movedOut = false;
try {
  await readNote(VAULT, 'facts/数学复习.md');
} catch {
  movedOut = true;
}
check('旧文件已移出 facts/', movedOut);

const recallNew = await recall('数学真题频率', { vaultDir: VAULT, dbPath: DB });
check('新事实可召回', recallNew.items.some((i) => i.path === replaced.path));
check('旧版默认不召回', !recallNew.items.some((i) => i.path === replaced.superseded.to));

// 10) confirm：draft → active
const drafts = await listDrafts({ vaultDir: VAULT });
check('draft 列表可读', drafts.length > 0, `${drafts.length} 条`);
const confirmed = await confirmDraft({ vaultDir: VAULT, dbPath: DB, id: drafts[0].id });
const confirmedNote = await readNote(VAULT, confirmed.path);
check('确认转 active 并记 confirmed_at', confirmedNote.status === 'active' && Boolean(confirmedNote.meta.confirmed_at) && confirmed.path.startsWith('facts/'));
check('确认后不在 draft 列表', !(await listDrafts({ vaultDir: VAULT })).some((d) => d.id === drafts[0].id));

// 11) discard：draft → expired，文件保留
const drafts2 = await listDrafts({ vaultDir: VAULT });
const discarded = await discardDraft({ vaultDir: VAULT, dbPath: DB, id: drafts2[0].id, reason: '测试丢弃' });
const discardedNote = await readNote(VAULT, discarded.path);
check('丢弃转 expired 且文件保留', discardedNote.status === 'expired' && discarded.path.startsWith('inbox/'), discarded.path);

// 12) 30 天未确认自动 expired
const willExpire = await capture({ vaultDir: VAULT, dbPath: DB, text: '助手猜测：用户喜欢模考。', source: 'assistant' });
const later = new Date(Date.now() + 31 * 86400000);
const expiredIds = await expireDrafts({ vaultDir: VAULT, dbPath: DB, days: 30, now: later });
check('30 天未确认自动 expired', expiredIds.includes(willExpire.id), `清理 ${expiredIds.length} 条`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败项：${failed.map((f) => f.name).join('；')}`);
  process.exitCode = 1;
}
