// เก็บ hash รหัสผ่านใหม่ (scrypt) ที่ <data dir>/auth.json — ใน volume manager-data ไม่ใช่ .env
// (.env เข้า container ผ่าน env_file อย่างเดียว เขียนกลับจาก container ไม่ได้ และเราไม่แตะ .env เลย:
//  hash SHA-256 เดิมใน .env คือตาข่ายนิรภัย ถ้า auth.json หาย/เสีย ยัง login ด้วยรหัสเดิมได้ และ rollback image เก่าได้)
//
// รูปแบบไฟล์: { "version": 1, "hash": "scrypt$...", "weak": false, "changedAt": <ms>, "migratedFromLegacy": true|false }
// ห้าม log ค่า hash/รหัสผ่าน
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const { isScryptHash } = require('./password');

function filePath() {
  return config.authFile;
}

// เตือนซ้ำเรื่องเดิมทุก 5 วินาที (getChangedAt) จะท่วม log — เตือนครั้งเดียวต่อสาเหตุ แล้วล้างเมื่อเขียนไฟล์ใหม่สำเร็จ
let lastWarning = null;
function warnOnce(msg) {
  if (lastWarning === msg) return;
  lastWarning = msg;
  logger.warn(msg);
}

// คืน object ที่ใช้ได้ หรือ null (ไม่มีไฟล์ / พัง / hash ผิดรูป) — พังต้องไม่ throw เพื่อให้ fall back ไป .env ได้
function load() {
  const p = filePath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warnOnce(`auth-store: อ่าน ${path.basename(p)} ไม่ได้ (${err.code || 'error'}) — ใช้ hash จาก .env แทน`);
    return null;
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !isScryptHash(doc.hash)) throw new Error('invalid format');
    return {
      hash: doc.hash,
      weak: doc.weak === true,
      changedAt: Number.isFinite(doc.changedAt) ? doc.changedAt : 0,
      migratedFromLegacy: doc.migratedFromLegacy === true,
    };
  } catch (err) {
    warnOnce(`auth-store: ${path.basename(p)} ใช้ไม่ได้ (${err.message}) — ใช้ hash จาก .env แทน`);
    return null;
  }
}

// เขียนแบบ atomic (.tmp + rename) สิทธิ์ 0600 — คืน true/false ไม่ throw (เขียนไม่ได้ต้องไม่ทำให้ login ล้ม)
// invalidateSessions=true (เปลี่ยนรหัสจริง) → changedAt = ตอนนี้ ทำให้ session ที่ออกก่อนหน้าหมดอายุ;
// false (migrate hash โดยรหัสเดิม) → คงค่า changedAt เดิม ไม่เตะ session ของคนที่ login อยู่
function save({ hash, weak = false, migratedFromLegacy = false, invalidateSessions = false }) {
  if (!isScryptHash(hash)) throw new Error('auth-store: hash must be scrypt format');
  const p = filePath();
  const tmp = `${p}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const prev = load();
    const changedAt = invalidateSessions ? Date.now() : (prev ? prev.changedAt : 0);
    const doc = { version: 1, hash, weak: !!weak, changedAt, migratedFromLegacy: !!migratedFromLegacy };
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, p);
    cache.at = 0; // ให้ getChangedAt อ่านใหม่ทันที
    lastWarning = null;
    return true;
  } catch (err) {
    logger.error(`auth-store: เขียน ${path.basename(p)} ไม่สำเร็จ (${err.code || err.message})`);
    try { fs.unlinkSync(tmp); } catch { /* ไม่มีไฟล์ tmp */ }
    return false;
  }
}

// เวลาที่เปลี่ยนรหัสล่าสุด (ms) — session ที่ออกก่อนหน้านี้ถือว่าหมดอายุ
// cache 5 วินาทีเพื่อไม่ต้องอ่านไฟล์ทุก request (CLI set-password เป็นคนละ process จึงต้องอ่านจากไฟล์)
const cache = { at: 0, value: 0 };
const CACHE_MS = 5000;
function getChangedAt() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.value;
  const doc = load();
  cache.at = now;
  cache.value = doc ? doc.changedAt : 0;
  return cache.value;
}

function clearCache() {
  cache.at = 0;
}

module.exports = { load, save, getChangedAt, clearCache, filePath };
