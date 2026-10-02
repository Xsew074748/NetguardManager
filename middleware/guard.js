const crypto = require('crypto');
const config = require('../config');
const logger = require('../services/logger');
const password = require('../services/password');
const authStore = require('../services/auth-store');

const SESSION_COOKIE = 'ng_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 10 * 60 * 1000;
const sessions = new Map(); // token → { expiresAt, createdAt }

// ── ตรวจรหัสผ่าน ────────────────────────────────────────────────────────────────
// ลำดับ:
//   1) data/auth.json (scrypt) ถ้ามีและใช้ได้ → เป็นตัวตัดสินเพียงที่เดียว (รหัสเก่าใน .env ใช้ไม่ได้อีกหลังเปลี่ยนรหัส)
//   2) ไม่งั้นใช้ MANAGER_PASSWORD_HASH จาก .env:
//        - SHA-256 เดิม: ตรวจได้ → login สำเร็จแล้ว migrate เป็น scrypt ลง auth.json อัตโนมัติ (ไม่แตะ .env)
//        - scrypt: ตรวจตรงๆ
//   3) ไม่มี hash เลย/รูปแบบไม่รู้จัก → ปิด login (fail closed) — ไม่มีรหัสเริ่มต้น "admin" อีกแล้ว
// คืน { ok, reason?, migrated?, weak? } — ห้ามใส่รหัสผ่านหรือ hash ลง log/ผลลัพธ์
let warnedNoHash = false;
async function authenticate(input) {
  if (typeof input !== 'string' || input === '' || input.length > password.MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: 'invalid-input' };
  }

  const stored = authStore.load();
  if (stored) {
    const ok = await password.verifyPassword(input, stored.hash);
    return ok ? { ok: true, weak: stored.weak } : { ok: false, reason: 'bad-password' };
  }

  const envHash = (config.managerPasswordHash || '').trim();
  if (!envHash) {
    if (!warnedNoHash) {
      logger.error('auth: ไม่มี hash รหัสผ่าน (ทั้ง auth.json และ MANAGER_PASSWORD_HASH) — ปิดการ login ตั้งรหัสด้วย scripts/set-password.js');
      warnedNoHash = true;
    }
    return { ok: false, reason: 'no-hash-configured' };
  }

  if (password.isScryptHash(envHash)) {
    const ok = await password.verifyPassword(input, envHash);
    return ok ? { ok: true, weak: input.length < password.MIN_PASSWORD_LENGTH } : { ok: false, reason: 'bad-password' };
  }

  if (password.isLegacySha256(envHash)) {
    if (!password.verifyLegacy(input, envHash)) return { ok: false, reason: 'bad-password' };
    // รหัสถูก → ย้ายเป็น scrypt (เขียนไม่ได้ก็ยัง login ผ่าน: ลองใหม่รอบถัดไป)
    const weak = input.length < password.MIN_PASSWORD_LENGTH;
    let migrated = false;
    try {
      migrated = authStore.save({ hash: await password.hashPassword(input), weak, migratedFromLegacy: true });
    } catch (err) {
      logger.error(`auth: migrate hash ไม่สำเร็จ (${err.message})`);
    }
    return { ok: true, migrated, weak };
  }

  logger.error('auth: MANAGER_PASSWORD_HASH รูปแบบไม่รู้จัก (ต้องเป็น SHA-256 hex 64 ตัว หรือ scrypt$...) — ปิดการ login');
  return { ok: false, reason: 'unsupported-hash-format' };
}

// รหัสผ่านปัจจุบันถูกมองว่า "อ่อน" (< 12 ตัว) ไหม — ให้ UI แสดง banner เตือน (รู้ได้เฉพาะหลัง migrate ที่เก็บ flag ไว้)
function isPasswordWeak() {
  const stored = authStore.load();
  return !!(stored && stored.weak);
}

// ── Session ─────────────────────────────────────────────────────────────────────
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { expiresAt: now + SESSION_TTL_MS, createdAt: now });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function destroyAllSessions() {
  sessions.clear();
}

function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return false;
  }
  // เปลี่ยนรหัสผ่าน (CLI คนละ process) → session ที่ออกก่อนหน้าใช้ไม่ได้
  if (s.createdAt < authStore.getChangedAt()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// ตัวระบุ session แบบย่อ สำหรับ audit log — ไม่ใช่ token (hash ตัดสั้น เอา token กลับไม่ได้)
function sessionActor(token) {
  if (!token) return 'anonymous';
  return `sess-${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8)}`;
}

function sweepSessions(now = Date.now()) {
  let removed = 0;
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) { sessions.delete(token); removed++; }
  }
  return removed;
}
setInterval(sweepSessions, SESSION_SWEEP_MS).unref();

// ── Layer 1: network guard — Tailscale (100.64.0.0/10) + private LAN only ──
function isPrivateIP(ip) {
  if (!ip) return false;
  let addr = ip;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1' || addr === '127.0.0.1' || addr === 'localhost') return true;

  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT range
  return false;
}

function networkGuard(req, res, next) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress);
  if (!isPrivateIP(ip)) {
    logger.warn(`Blocked request from disallowed IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── Layer 2: session auth ──
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  networkGuard,
  requireAuth,
  authenticate,
  isPasswordWeak,
  createSession,
  destroySession,
  destroyAllSessions,
  isValidSession,
  sessionActor,
  sweepSessions,
  isPrivateIP,
};
