// Password hashing ด้วย scrypt (Node built-in — ไม่มี dependency/native module เพิ่ม)
//
// รูปแบบที่เก็บ:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
//   เก็บพารามิเตอร์ไว้ในสตริง → เปลี่ยนค่าเริ่มต้นภายหลังได้โดยไม่ทำให้ hash เก่าตรวจไม่ผ่าน
// รูปแบบเดิม (legacy): SHA-256 hex 64 ตัว ไม่มี salt — ใช้ตรวจอย่างเดียวเพื่อ migrate ห้ามสร้างใหม่ (ยกเว้นใน test)
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024; // กัน DoS จากรหัสยาวมาก
const DEFAULTS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
// เพดานพารามิเตอร์ตอน "ตรวจ" — กัน hash ที่ถูกแก้ (เช่น auth.json) สั่งให้กิน CPU/RAM มหาศาล
const LIMITS = { Nmax: 2 ** 20, rmax: 16, pmax: 4 };

const SCRYPT_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;
const LEGACY_RE = /^[0-9a-fA-F]{64}$/;

const maxmemFor = (N, r) => 128 * N * r * 2 + 1024 * 1024;

// opts: { N, r, p } — ให้ test ใช้ค่าต่ำเพื่อความเร็ว (ห้ามใช้ค่าต่ำใน production)
async function hashPassword(password, opts = {}) {
  if (typeof password !== 'string' || password === '') throw new Error('password required');
  const { N, r, p } = { ...DEFAULTS, ...opts };
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function isScryptHash(str) {
  return typeof str === 'string' && SCRYPT_RE.test(str);
}

function isLegacySha256(str) {
  return typeof str === 'string' && LEGACY_RE.test(str);
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD_LENGTH) return false;
  const m = typeof stored === 'string' ? stored.match(SCRYPT_RE) : null;
  if (!m) return false;
  const N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3]);
  if (!(N >= 2 && (N & (N - 1)) === 0) || N > LIMITS.Nmax || r < 1 || r > LIMITS.rmax || p < 1 || p > LIMITS.pmax) return false;
  const salt = Buffer.from(m[4], 'base64');
  const expected = Buffer.from(m[5], 'base64');
  if (expected.length === 0 || expected.length > 128) return false;
  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ตรวจ SHA-256 แบบเดิมเพื่อ migrate เท่านั้น
function legacySha256(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function verifyLegacy(password, storedHex) {
  if (typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD_LENGTH || !isLegacySha256(storedHex)) return false;
  const a = Buffer.from(legacySha256(password), 'utf8');
  const b = Buffer.from(String(storedHex).toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// คืน null ถ้าผ่าน หรือข้อความอธิบายเหตุผลที่ไม่ผ่าน
function validateNewPassword(password) {
  if (typeof password !== 'string') return 'รหัสผ่านต้องเป็นข้อความ';
  if (password.length < MIN_PASSWORD_LENGTH) return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`;
  if (password.length > MAX_PASSWORD_LENGTH) return `รหัสผ่านยาวเกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`;
  return null;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  isScryptHash,
  isLegacySha256,
  legacySha256,
  verifyLegacy,
  validateNewPassword,
};
