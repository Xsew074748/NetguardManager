const fs = require('fs');
const path = require('path');
const config = require('../config');

// เวลาแจ้งเตือนสรุปประจำวันของ bot — เก็บใน bots/<name>/data/settings.json (key "dailySummaryTimes")
// ซึ่งเป็น volume เดียวกับ users.json ของ bot (/app/data) จึงอยู่รอดหลัง recreate และ bot อ่านตอน start ได้เลย
// bot ตั้ง cron ใหม่ทันทีเมื่อถูกเรียก POST /api/daily-summary/reload (ดู routes/api.js) — ไม่ต้อง restart
const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const DEFAULT_TIMES = ['08:00', '17:00'];
const MAX_TIMES = 24;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validationError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// กฎเดียวกับ validateTimes ใน LineBot/services/daily-summary.js — แก้ที่หนึ่งต้องแก้อีกที่ (bot ตรวจซ้ำตอนอ่านไฟล์)
function validateTimes(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'เวลาต้องเป็นรายการ (array) ของ HH:mm' };
  if (list.length === 0) return { ok: false, error: 'ต้องมีเวลาอย่างน้อย 1 ค่า' };
  if (list.length > MAX_TIMES) return { ok: false, error: `ตั้งได้ไม่เกิน ${MAX_TIMES} เวลา` };
  for (const v of list) {
    if (typeof v !== 'string' || !TIME_RE.test(v)) {
      return { ok: false, error: `รูปแบบเวลาไม่ถูกต้อง: "${String(v).slice(0, 20)}" (ต้องเป็น HH:mm 24 ชม. 00:00–23:59)` };
    }
  }
  const dup = list.find((v, i) => list.indexOf(v) !== i);
  if (dup) return { ok: false, error: `เวลาซ้ำกัน: ${dup}` };
  return { ok: true, times: [...list].sort() };
}

function settingsPath(botName) {
  if (typeof botName !== 'string' || !BOT_NAME_RE.test(botName)) throw validationError('Invalid bot name');
  const root = path.resolve(config.botsRoot);
  const target = path.resolve(root, botName);
  if (target === root || !target.startsWith(root + path.sep)) throw validationError('Invalid bot name');
  return path.join(target, 'data', 'settings.json');
}

function readDoc(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    return doc;
  } catch {
    throw validationError('settings.json ของ bot เสียหาย (อ่านเป็น JSON ไม่ได้) — ไม่เขียนทับเพื่อกันข้อมูลอื่นหาย', 409);
  }
}

function readTimes(botName) {
  const doc = readDoc(settingsPath(botName));
  if (doc.dailySummaryTimes === undefined) return { times: [...DEFAULT_TIMES], source: 'default' };
  const v = validateTimes(doc.dailySummaryTimes);
  return v.ok ? { times: v.times, source: 'file' } : { times: [...DEFAULT_TIMES], source: 'default', invalid: v.error };
}

// validate → อ่านไฟล์เดิม (เก็บ key อื่นไว้) → เขียน atomic (.tmp แล้ว rename)
function writeTimes(botName, input) {
  const file = settingsPath(botName);
  const v = validateTimes(input);
  if (!v.ok) throw validationError(v.error);
  const doc = readDoc(file);
  doc.dailySummaryTimes = v.times;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  return { times: v.times };
}

module.exports = { validateTimes, readTimes, writeTimes, settingsPath, DEFAULT_TIMES };
