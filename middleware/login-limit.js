// จำกัดการ login ที่ผิด — ใช้ express-rate-limit ตัวเดิม (ไม่เพิ่ม dependency) แบบ 2 ชั้น
//   1) ต่อ IP:   perIpMax ครั้งผิดใน windowMs (ค่าเริ่มต้น 5 / 15 นาที)
//   2) ทั้งระบบ: globalMax ครั้งผิดใน windowMs (ค่าเริ่มต้น 20 / 15 นาที)
// ทำไมต้องมีชั้นที่ 2: บน Docker Desktop ทุก client ถูก NAT เป็น IP gateway เดียวกัน (เช่น 172.18.0.1) → "ต่อ IP" แยกคนไม่ได้
//   เพดานรวมจำกัดจำนวนครั้งที่เดารหัสได้ทั้งระบบ แต่ก็ล็อกแอดมินตัวจริงได้เช่นกันเมื่อถูกยิงรหัสผิด (ยอมรับ trade-off;
//   ทางแก้จริงคือจำกัดที่ network layer — งานแยก)
// นับเฉพาะ response ที่ผิด (status ≥ 400): login สำเร็จไม่กินโควตา; ล็อกอยู่ในหน่วยความจำ (restart แล้วรีเซ็ต)
const rateLimit = require('express-rate-limit');

const DEFAULTS = { windowMs: 15 * 60 * 1000, perIpMax: 5, globalMax: 20 };

// onBlocked(req, scope) เรียกตอนปฏิเสธ (scope = 'ip' | 'global') — ใช้เขียน audit/log; keyForIp ฉีดได้เพื่อ test
function createLoginLimiters({ windowMs = DEFAULTS.windowMs, perIpMax = DEFAULTS.perIpMax, globalMax = DEFAULTS.globalMax, keyForIp, onBlocked = () => {} } = {}) {
  const common = (scope) => ({
    windowMs,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      try { onBlocked(req, scope); } catch { /* ห้ามทำให้ตอบ 429 ไม่ได้ */ }
      res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
    },
  });
  const globalLimiter = rateLimit({ ...common('global'), limit: globalMax, keyGenerator: () => 'global', validate: false });
  const ipLimiter = rateLimit({ ...common('ip'), limit: perIpMax, ...(keyForIp ? { keyGenerator: keyForIp, validate: false } : {}) });
  return [globalLimiter, ipLimiter];
}

// limiter ของ "เปลี่ยนรหัสผ่าน" — แยกอินสแตนซ์จาก login (รหัสเดิมผิดซ้ำไม่ไปล็อก login) และ **ไม่ผูก IP**
// (ทุกคำขอมาจาก IP เดียวหลัง Docker NAT/tunnel) นับรวมทั้งระบบ; นับเฉพาะ response 403 (= รหัสเดิมผิด) —
// 400 (รหัสใหม่ไม่ผ่านกฎ) และสำเร็จไม่กินโควตา; ตรวจก่อน handler จึงถูกตัดก่อนเรียก scrypt
const PASSWORD_CHANGE_DEFAULTS = { windowMs: 15 * 60 * 1000, max: 5 };

function createPasswordChangeLimiter({ windowMs = PASSWORD_CHANGE_DEFAULTS.windowMs, max = PASSWORD_CHANGE_DEFAULTS.max, onBlocked = () => {} } = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    keyGenerator: () => 'password-change',
    validate: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 403,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      try { onBlocked(req); } catch { /* ห้ามทำให้ตอบ 429 ไม่ได้ */ }
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    },
  });
}

module.exports = { createLoginLimiters, createPasswordChangeLimiter, DEFAULTS, PASSWORD_CHANGE_DEFAULTS };
