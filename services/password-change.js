// เปลี่ยนรหัสผ่านผ่านเว็บ: ยืนยันรหัสเดิม → ตรวจรหัสใหม่ → hash (scrypt) → เขียน auth.json (atomic) → ทำให้ session เก่าหมดอายุ
// คืน { ok:true } หรือ { ok:false, status, reason, error } — ไม่ throw, ห้ามใส่รหัสผ่าน/hash ลงผลลัพธ์หรือ log
//
// ล็อกในโปรเซส (promise chain): คำขอเปลี่ยนรหัสพร้อมกันถูกจัดคิวทีละคำขอ — ชื่อไฟล์ชั่วคราวของ authStore.save เป็น `.tmp` ตายตัว
// ถ้าเขียนซ้อนกันจะชนกัน และคำขอที่สองต้องตรวจ "รหัสเดิม" กับสถานะหลังคำขอแรกเสร็จ (จึงได้ 403 ถ้ารหัสเดิมไม่ตรงอีกแล้ว)
const guard = require('../middleware/guard');
const password = require('./password');
const authStore = require('./auth-store');

function fail(status, reason, error) {
  return { ok: false, status, reason, error };
}

function createPasswordChanger({ hashOpts } = {}) {
  let chain = Promise.resolve();

  async function doChange(current, next) {
    let auth;
    try {
      auth = await guard.authenticate(current);
    } catch {
      return fail(500, 'error', 'ตรวจรหัสผ่านเดิมไม่สำเร็จ');
    }
    if (!auth.ok) {
      if (auth.reason === 'bad-password') return fail(403, 'bad-current', 'รหัสผ่านเดิมไม่ถูกต้อง');
      if (auth.reason === 'invalid-input') return fail(400, 'invalid-input', 'รหัสผ่านเดิมไม่ถูกต้อง');
      return fail(503, 'not-configured', 'ระบบยังไม่ได้ตั้งรหัสผ่านบนเซิร์ฟเวอร์');
    }
    if (next === current) return fail(400, 'same-as-current', 'รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม');

    let hash;
    try {
      hash = await password.hashPassword(next, hashOpts);
    } catch {
      return fail(500, 'error', 'สร้าง hash ไม่สำเร็จ');
    }
    const saved = authStore.save({ hash, weak: false, migratedFromLegacy: false, invalidateSessions: true });
    if (!saved) return fail(500, 'write-failed', 'บันทึกรหัสผ่านใหม่ไม่สำเร็จ — รหัสเดิมยังใช้ได้');
    return { ok: true };
  }

  // current/next ต้องเป็นสตริงที่ผ่านการตรวจรูปแบบแล้ว (ดู validateRequest)
  function change(current, next) {
    const run = chain.then(() => doChange(current, next));
    chain = run.catch(() => {});
    return run;
  }

  // ตรวจรูปแบบคำขอ (ไม่แตะ hash/ไฟล์) — คืน null ถ้าผ่าน หรือ { status, reason, error }
  function validateRequest(body) {
    const { current, next } = body || {};
    if (typeof current !== 'string' || current === '') return fail(400, 'invalid-input', 'กรอกรหัสผ่านเดิม');
    if (typeof next !== 'string') return fail(400, 'invalid-new', 'รหัสผ่านใหม่ต้องเป็นข้อความ');
    const problem = password.validateNewPassword(next);
    if (problem) return fail(400, 'invalid-new', problem);
    return null;
  }

  return { change, validateRequest };
}

module.exports = { createPasswordChanger };
