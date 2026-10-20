// state ของ Cloudflare ต่อบอท: <BOTS_ROOT>/<name>/cloudflare.json และรายการค้าง <โฟลเดอร์ของ stats.db>/cf-orphans.json
// (แผน: cf-auto-tunnel-plan.md) — ยังไม่ถูกเรียกจากที่ไหนในแอป
//
// หลักการ:
//   • ห้ามมี token / ความลับ — เขียนได้เฉพาะ field ใน whitelist และค่าต้องผ่านการตรวจรูปแบบ; key แปลก (โดยเฉพาะชื่อ token/secret) ถูกปฏิเสธ ไม่ใช่เงียบตัดทิ้ง
//   • เขียนแบบ atomic (.tmp แล้ว rename) สิทธิ์ 0600 เหมือน setEnvValue/meta.json
//   • ไฟล์เสีย/ผิดรูปแบบ = error code "corrupt" ห้ามคืน null (ผู้เรียกจะตีความว่า "ไม่มีอะไรให้ลบ" แล้วทิ้ง tunnel/DNS ค้าง) และห้ามเขียนทับแบบเงียบๆ
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { isValidId, isValidTunnelId, isValidHostname } = require('./cloudflare');

const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const STEPS = ['tunnel-created', 'ingress-set', 'dns-created', 'container-started', 'complete'];
const STATE_KEYS = ['accountId', 'zoneId', 'tunnelId', 'hostname', 'dnsRecordId', 'step'];
const UPDATABLE_KEYS = ['dnsRecordId', 'step'];
const ORPHAN_KEYS = ['botName', 'hostname', 'tunnelId', 'dnsRecordId', 'accountId', 'zoneId', 'reason'];
const MAX_REASON = 200;
const VERSION = 1;

class CloudflareStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CloudflareStateError';
    this.code = code;
  }
}

function invalid(message) {
  return new CloudflareStateError(message, 'invalid');
}

function corrupt(file, why) {
  return new CloudflareStateError(`${path.basename(file)} is corrupt (${why})`, 'corrupt');
}

function assertBotName(botName) {
  if (typeof botName !== 'string' || !BOT_NAME_RE.test(botName)) throw invalid('invalid bot name');
}

function statePath(botName) {
  assertBotName(botName);
  return path.join(config.botsRoot, botName, 'cloudflare.json');
}

function orphansPath() {
  return path.join(path.dirname(config.dbPath), 'cf-orphans.json');
}

function isTimestamp(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertOnlyKeys(obj, allowed, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid(`${what}: field "${key}" ไม่รองรับ (key not allowed)`);
  }
}

// ตรวจค่าของ field ที่มีอยู่ใน obj (required = ต้องมีครบ)
function validateFields(obj, { required }) {
  const checks = {
    accountId: (v) => isValidId(v),
    zoneId: (v) => isValidId(v),
    tunnelId: (v) => isValidTunnelId(v),
    hostname: (v) => isValidHostname(v),
    dnsRecordId: (v) => v === null || isValidId(v),
    step: (v) => STEPS.includes(v),
    botName: (v) => typeof v === 'string' && BOT_NAME_RE.test(v),
    reason: (v) => typeof v === 'string',
  };
  for (const key of required) {
    if (obj[key] === undefined) throw invalid(`missing field "${key}"`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (checks[key] && !checks[key](value)) throw invalid(`invalid value for "${key}"`);
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* บางระบบไฟล์ไม่รองรับ chmod */ }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ไม่มีไฟล์ tmp */ }
    throw err;
  }
}

// คืนค่าที่ parse แล้ว หรือ undefined ถ้าไม่มีไฟล์ (ไม่ใช้ null เพราะไฟล์ที่เนื้อหาเป็น "null" ต้องนับเป็น corrupt ไม่ใช่ "ไม่มีไฟล์"); ไฟล์ที่อ่านได้แต่ใช้ไม่ได้ = corrupt
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw corrupt(file, 'not valid JSON');
  }
}

// ── state ต่อบอท ──────────────────────────────────────────────────────────────
function readState(botName) {
  const file = statePath(botName);
  const doc = readJson(file);
  if (doc === undefined) return null;
  if (!isPlainObject(doc) || doc.version !== VERSION) throw corrupt(file, 'unexpected format');
  try {
    assertOnlyKeys(doc, ['version', 'createdAt', 'updatedAt', ...STATE_KEYS], 'state');
    validateFields(doc, { required: STATE_KEYS.filter((k) => k !== 'dnsRecordId') });
    if (doc.dnsRecordId === undefined) throw invalid('missing field "dnsRecordId"');
    if (!isTimestamp(doc.createdAt) || !isTimestamp(doc.updatedAt)) throw invalid('bad timestamps');
  } catch (err) {
    if (err instanceof CloudflareStateError) throw corrupt(file, err.message);
    throw err;
  }
  return doc;
}

function writeState(botName, input) {
  const file = statePath(botName);
  if (!isPlainObject(input)) throw invalid('state must be an object');
  assertOnlyKeys(input, STATE_KEYS, 'state');
  validateFields(input, { required: STATE_KEYS.filter((k) => k !== 'dnsRecordId') });
  const existing = readState(botName); // ไฟล์เดิมที่เสียต้องหยุดตรงนี้ ไม่เขียนทับ
  const now = new Date().toISOString();
  const doc = {
    version: VERSION,
    accountId: input.accountId,
    zoneId: input.zoneId,
    tunnelId: input.tunnelId,
    hostname: input.hostname,
    dnsRecordId: input.dnsRecordId === undefined ? null : input.dnsRecordId,
    step: input.step,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  writeAtomic(file, doc);
  return doc;
}

function updateState(botName, patch) {
  const existing = readState(botName);
  if (!existing) throw new CloudflareStateError('no cloudflare state for this bot', 'missing');
  if (!isPlainObject(patch)) throw invalid('patch must be an object');
  assertOnlyKeys(patch, UPDATABLE_KEYS, 'patch');
  validateFields(patch, { required: [] });
  const next = {};
  for (const key of STATE_KEYS) next[key] = key in patch ? patch[key] : existing[key];
  return writeState(botName, next);
}

function deleteState(botName) {
  const file = statePath(botName);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// ── รายการค้าง (Cloudflare ที่ลบไม่สำเร็จตอนลบบอท) ─────────────────────────────
function readOrphanDoc() {
  const file = orphansPath();
  const doc = readJson(file);
  if (doc === undefined) return { version: VERSION, orphans: [] };
  if (!isPlainObject(doc) || doc.version !== VERSION || !Array.isArray(doc.orphans)) throw corrupt(file, 'unexpected format');
  return doc;
}

function listOrphans() {
  return readOrphanDoc().orphans;
}

function addOrphan(entry) {
  if (!isPlainObject(entry)) throw invalid('orphan must be an object');
  assertOnlyKeys(entry, ORPHAN_KEYS, 'orphan');
  validateFields(entry, { required: ORPHAN_KEYS.filter((k) => k !== 'dnsRecordId') });
  const doc = readOrphanDoc(); // ไฟล์เสียต้องหยุดที่นี่ ไม่เขียนทับ
  const previous = doc.orphans.find((o) => o.tunnelId === entry.tunnelId);
  const now = new Date().toISOString();
  const row = {
    botName: entry.botName,
    hostname: entry.hostname,
    tunnelId: entry.tunnelId,
    dnsRecordId: entry.dnsRecordId === undefined ? null : entry.dnsRecordId,
    accountId: entry.accountId,
    zoneId: entry.zoneId,
    reason: entry.reason.slice(0, MAX_REASON),
    createdAt: previous ? previous.createdAt : now,
    updatedAt: now,
  };
  doc.orphans = doc.orphans.filter((o) => o.tunnelId !== entry.tunnelId).concat(row);
  writeAtomic(orphansPath(), doc);
  return row;
}

function removeOrphan(tunnelId) {
  if (!isValidTunnelId(tunnelId)) throw invalid('invalid tunnel id');
  const doc = readOrphanDoc();
  const remaining = doc.orphans.filter((o) => o.tunnelId !== tunnelId);
  if (remaining.length === doc.orphans.length) return false;
  doc.orphans = remaining;
  writeAtomic(orphansPath(), doc);
  return true;
}

module.exports = {
  CloudflareStateError,
  STEPS,
  readState,
  writeState,
  updateState,
  deleteState,
  listOrphans,
  addOrphan,
  removeOrphan,
};
