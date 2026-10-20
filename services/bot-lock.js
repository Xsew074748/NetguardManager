// ล็อกต่อชื่อบอทในโปรเซสเดียว: กันสร้าง/ลบ/ลองใหม่ (ขั้น Cloudflare ที่ย้อนกลับได้ไม่ปลอดภัยถ้าซ้อนกัน) ของบอทชื่อเดียวกันพร้อมกัน
// คำขอที่สองไม่รอคิว — ถูกปฏิเสธทันทีด้วย 409 (code "busy") · ล็อกอยู่ในหน่วยความจำ: Manager ต้องรันโปรเซสเดียว (ห้ามรันสองเครื่องพร้อมกัน)
// ถ้า Manager restart กลางทาง ล็อกหายแต่ state บนดิสก์ (cloudflare.json) ยังพอให้ทำต่อ/ล้างได้
const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const held = new Map(); // ชื่อบอท → โทเคนของผู้ถือ

function lockError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function assertName(name) {
  if (typeof name !== 'string' || !BOT_NAME_RE.test(name)) throw lockError('Invalid bot name', 400, 'invalid-name');
}

// คืนฟังก์ชัน release — เรียกซ้ำได้ และไม่ปล่อยล็อกของผู้ถือคนใหม่
function acquire(name) {
  assertName(name);
  if (held.has(name)) throw lockError(`Bot "${name}" is busy — another create/delete is in progress`, 409, 'busy');
  const token = Symbol(name);
  held.set(name, token);
  return function release() {
    if (held.get(name) === token) held.delete(name);
  };
}

function isLocked(name) {
  return typeof name === 'string' && held.has(name);
}

async function withBotLock(name, fn) {
  assertName(name);
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  const release = acquire(name);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = { acquire, isLocked, withBotLock };
