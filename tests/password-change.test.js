'use strict';
// เปลี่ยนรหัสผ่านผ่านเว็บ: POST /api/auth/password (routes/auth.js createAuthRouter, services/password-change.js)
// รหัสทดสอบสร้างสุ่มขึ้นเองทุกครั้งที่รัน ไม่มีรหัสจริง

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-pwchange-'));
process.env.BOTS_ROOT = root;
process.env.DB_PATH = path.join(root, 'stats.test.db');
process.env.AUTH_FILE = path.join(root, 'auth.json');

const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('../config');
const password = require('../services/password');
const authStore = require('../services/auth-store');
const guard = require('../middleware/guard');
const statsDb = require('../services/stats-db');
const logger = require('../services/logger');

statsDb.initDb();
test.after(() => statsDb.closeDb());

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const rnd = (tag) => `${tag}-${crypto.randomBytes(9).toString('hex')}`; // 18 hex + tag → ยาว ≥ 12 เสมอ
const sha = (s) => password.legacySha256(s);
const XRW = { 'X-Requested-With': 'fetch' };

function resetAuthState({ envHash = '' } = {}) {
  try { fs.unlinkSync(config.authFile); } catch { /* ไม่มีไฟล์ */ }
  try { fs.unlinkSync(`${config.authFile}.tmp`); } catch { /* ไม่มีไฟล์ */ }
  authStore.clearCache();
  guard.destroyAllSessions();
  config.managerPasswordHash = envHash;
}

async function startApp(t, { envPassword, limiter } = {}) {
  const current = envPassword || rnd('cur');
  resetAuthState({ envHash: sha(current) });
  const { createAuthRouter } = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter({ hashOpts: FAST, passwordLimiter: limiter || { max: 5, windowMs: 60000 } }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (pw = current) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  const change = (cookie, body, headers = {}) => fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...XRW, ...headers },
    body: JSON.stringify(body),
  });
  const status = (cookie) => fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
  return { base, current, login, change, status };
}

const readAuthFile = () => JSON.parse(fs.readFileSync(config.authFile, 'utf8'));

// ── validateNewPassword (กฎใหม่: ห้ามตัวอักษรตัวเดียวซ้ำทั้งสาย) ───────────────────
test('validateNewPassword: ตัวอักษรตัวเดียวซ้ำทั้งสายถูกปฏิเสธ แม้ยาวพอ', () => {
  assert.notEqual(password.validateNewPassword('a'.repeat(12)), null);
  assert.notEqual(password.validateNewPassword('a'.repeat(40)), null);
  assert.notEqual(password.validateNewPassword('9'.repeat(30)), null);
  assert.notEqual(password.validateNewPassword('ก'.repeat(15)), null);
  assert.equal(password.validateNewPassword('a'.repeat(11) + 'b'), null);
  assert.equal(password.validateNewPassword(rnd('ok')), null);
});

test('validateNewPassword: ยังบังคับ 12..1024 ตามเดิม', () => {
  assert.notEqual(password.validateNewPassword(rnd('x').slice(0, 11)), null);
  assert.notEqual(password.validateNewPassword(`${rnd('p')}${'z'.repeat(1100)}`), null);
  assert.notEqual(password.validateNewPassword(undefined), null);
  assert.notEqual(password.validateNewPassword(12345678901234), null);
});

// ── route ────────────────────────────────────────────────────────────────────
test('ไม่ได้ login → 401 และไม่แตะ auth.json', async (t) => {
  const a = await startApp(t);
  const res = await a.change(null, { current: a.current, next: rnd('new') });
  assert.equal(res.status, 401);
  assert.equal(fs.existsSync(config.authFile), false);
});

test('ไม่มี X-Requested-With → 403 และรหัสไม่เปลี่ยน', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const res = await fetch(`${a.base}/api/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ current: a.current, next: rnd('new') }) });
  assert.equal(res.status, 403);
  assert.equal((await authStore.load()).hash.startsWith('scrypt$'), true); // migrate จาก login เท่านั้น
  assert.equal((await guard.authenticate(a.current)).ok, true);
});

test('Origin คนละโดเมนกับ Host → 403 และรหัสไม่เปลี่ยน', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const res = await a.change(cookie, { current: a.current, next: rnd('new') }, { Origin: 'https://evil.example.net' });
  assert.equal(res.status, 403);
  assert.equal((await guard.authenticate(a.current)).ok, true);
});

test('Origin ตรงกับ Host → เปลี่ยนได้', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const host = new URL(a.base).host;
  const res = await a.change(cookie, { current: a.current, next: rnd('new') }, { Origin: `http://${host}` });
  assert.equal(res.status, 200);
});

test('รหัสเดิมผิด → 403 (ห้าม 401) และ auth.json/รหัสไม่เปลี่ยน', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const before = readAuthFile();
  const res = await a.change(cookie, { current: rnd('wrong'), next: rnd('new') });
  assert.equal(res.status, 403);
  assert.deepEqual(readAuthFile(), before);
  assert.equal((await guard.authenticate(a.current)).ok, true);
});

test('รหัสใหม่ไม่ผ่านกฎ (สั้น/ซ้ำตัวเดียว/ยาวเกิน/ชนิดผิด) → 400 ไม่เปลี่ยนรหัส', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const before = readAuthFile();
  for (const bad of ['short1', 'a'.repeat(20), `${rnd('z')}${'q'.repeat(1100)}`, 12345678901234, null, undefined, { x: 1 }]) {
    const res = await a.change(cookie, { current: a.current, next: bad });
    assert.equal(res.status, 400, `next=${typeof bad}`);
  }
  assert.deepEqual(readAuthFile(), before);
});

test('รหัสใหม่ซ้ำรหัสเดิม → 400', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const res = await a.change(cookie, { current: a.current, next: a.current });
  assert.equal(res.status, 400);
});

test('body ไม่ครบ/ผิดชนิด → 400 (current ต้องเป็นสตริง)', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  for (const body of [{}, { next: rnd('n') }, { current: 123, next: rnd('n') }, { current: a.current }]) {
    const res = await a.change(cookie, body);
    assert.equal(res.status, 400);
  }
});

test('สำเร็จ: auth.json เป็น scrypt ใหม่, weak=false, changedAt ขยับ, ไม่ใช่ migratedFromLegacy, ไม่เหลือ .tmp', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const before = readAuthFile();
  await new Promise((r) => setTimeout(r, 15));
  const next = rnd('new');
  const res = await a.change(cookie, { current: a.current, next });
  assert.equal(res.status, 200);
  const after = readAuthFile();
  assert.equal(password.isScryptHash(after.hash), true);
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.weak, false);
  assert.equal(after.migratedFromLegacy, false);
  assert.ok(after.changedAt > before.changedAt);
  assert.equal(after.version, 1);
  assert.equal(fs.existsSync(`${config.authFile}.tmp`), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(config.authFile).mode & 0o777, 0o600);
  assert.equal(await password.verifyPassword(next, after.hash), true);
});

test('สำเร็จ: รหัสเก่า login ไม่ได้ รหัสใหม่ login ได้', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const next = rnd('new');
  assert.equal((await a.change(cookie, { current: a.current, next })).status, 200);
  assert.equal((await guard.authenticate(a.current)).ok, false);
  assert.equal((await guard.authenticate(next)).ok, true);
});

test('สำเร็จ: ผู้เปลี่ยนได้ session ใหม่ (cookie ใหม่ใช้ได้) ส่วน session เดิมและ session อื่นใช้ไม่ได้', async (t) => {
  const a = await startApp(t);
  const cookieA = await a.login();
  const cookieB = await a.login();
  const res = await a.change(cookieA, { current: a.current, next: rnd('new') });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie && /ng_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));
  const newCookie = setCookie.split(';')[0];
  assert.notEqual(newCookie, cookieA);
  assert.equal((await a.status(newCookie)).loggedIn, true);
  assert.equal((await a.status(cookieA)).loggedIn, false);
  assert.equal((await a.status(cookieB)).loggedIn, false);
});

test('สำเร็จ: ตอบ envHashStale และ /status แจ้ง envHashStale=true เมื่อ .env ยังมี hash เก่า', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  assert.equal((await a.status(cookie)).envHashStale, undefined); // migrate โดยรหัสเดิม → .env ยังตรง ไม่ล้าสมัย
  const res = await a.change(cookie, { current: a.current, next: rnd('new') });
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.envHashStale, true);
  const newCookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await a.status(newCookie)).envHashStale, true);
});

test('/status ไม่เปิดเผย envHashStale ให้คนที่ยังไม่ login', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  await a.change(cookie, { current: a.current, next: rnd('new') });
  const anon = await (await fetch(`${a.base}/api/auth/status`)).json();
  assert.deepEqual(anon, { loggedIn: false });
});

test('.env ไม่มี hash แต่ auth.json ถูกตั้งแล้ว → ไม่มี envHashStale (ไม่มีอะไรให้ล้าสมัย)', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  config.managerPasswordHash = '';
  const res = await a.change(cookie, { current: a.current, next: rnd('new') });
  const body = await res.json();
  assert.equal(body.envHashStale, false);
});

test('ธง weak: รหัสเดิมสั้น (weak) → เปลี่ยนแล้วธงหาย', async (t) => {
  const a = await startApp(t, { envPassword: 'short-pw-1' });
  const cookie = await a.login('short-pw-1');
  assert.equal((await a.status(cookie)).weakPassword, true);
  const res = await a.change(cookie, { current: 'short-pw-1', next: rnd('new') });
  assert.equal(res.status, 200);
  const newCookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await a.status(newCookie)).weakPassword, false);
});

test('เขียน auth.json ไม่ได้ → 500, รหัสเดิมยังใช้ได้, session เดิมยังอยู่', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const orig = authStore.save;
  authStore.save = () => false;
  t.after(() => { authStore.save = orig; });
  const res = await a.change(cookie, { current: a.current, next: rnd('new') });
  assert.equal(res.status, 500);
  authStore.save = orig;
  assert.equal((await guard.authenticate(a.current)).ok, true);
  assert.equal((await a.status(cookie)).loggedIn, true);
});

// ── rate limit: นับรวมทั้งระบบ ไม่ผูก IP ───────────────────────────────────────
test('รหัสเดิมผิดครบ 5 ครั้ง → ครั้งที่ 6 ได้ 429 แม้ใส่รหัสถูก และ "ก่อนเรียก scrypt"', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  for (let i = 0; i < 5; i++) assert.equal((await a.change(cookie, { current: rnd('wrong'), next: rnd('new') })).status, 403);

  let scryptCalls = 0;
  const origVerify = password.verifyPassword; const origHash = password.hashPassword;
  password.verifyPassword = (...x) => { scryptCalls++; return origVerify(...x); };
  password.hashPassword = (...x) => { scryptCalls++; return origHash(...x); };
  t.after(() => { password.verifyPassword = origVerify; password.hashPassword = origHash; });

  const res = await a.change(cookie, { current: a.current, next: rnd('new') });
  assert.equal(res.status, 429);
  assert.equal(scryptCalls, 0, 'ต้องตัดที่ limiter ก่อนแตะ scrypt');
  assert.equal(readAuthFile().changedAt === readAuthFile().changedAt, true);
});

test('limiter ไม่ผูก IP: header x-forwarded-for / x-test-ip ต่างกัน ก็ยังนับรวมเป็นก้อนเดียว', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  for (let i = 0; i < 5; i++) {
    const res = await a.change(cookie, { current: rnd('wrong'), next: rnd('new') }, { 'X-Forwarded-For': `203.0.113.${i + 1}` });
    assert.equal(res.status, 403);
  }
  const res = await a.change(cookie, { current: a.current, next: rnd('new') }, { 'X-Forwarded-For': '198.51.100.99' });
  assert.equal(res.status, 429);
});

test('นับเฉพาะ "รหัสเดิมผิด": 400 (รหัสใหม่ไม่ผ่านกฎ) และสำเร็จไม่กินโควตา', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  for (let i = 0; i < 8; i++) assert.equal((await a.change(cookie, { current: a.current, next: 'short' })).status, 400);
  assert.equal((await a.change(cookie, { current: rnd('wrong'), next: rnd('new') })).status, 403);
});

test('limiter ของเปลี่ยนรหัสแยกจาก login: รหัสเดิมผิดครบจนถูกล็อก แต่ login ยังเข้าได้', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  for (let i = 0; i < 5; i++) await a.change(cookie, { current: rnd('wrong'), next: rnd('new') });
  assert.equal((await a.change(cookie, { current: a.current, next: rnd('new') })).status, 429);
  const res = await fetch(`${a.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: a.current }) });
  assert.equal(res.status, 200);
});

test('ปลดล็อกเมื่อครบ window', async (t) => {
  const a = await startApp(t, { limiter: { max: 2, windowMs: 300 } });
  const cookie = await a.login();
  for (let i = 0; i < 2; i++) await a.change(cookie, { current: rnd('wrong'), next: rnd('new') });
  assert.equal((await a.change(cookie, { current: a.current, next: rnd('new') })).status, 429);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await a.change(cookie, { current: a.current, next: rnd('new') })).status, 200);
});

// ── เปลี่ยนพร้อมกัน ─────────────────────────────────────────────────────────────
test('เปลี่ยนรหัสพร้อมกัน 2 คำขอ: สำเร็จได้แค่ 1 อีกอันเจอรหัสเดิมผิด (403), auth.json ไม่พัง, ไม่เหลือ .tmp', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const n1 = rnd('one'); const n2 = rnd('two');
  const [r1, r2] = await Promise.all([
    a.change(cookie, { current: a.current, next: n1 }),
    a.change(cookie, { current: a.current, next: n2 }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 403]);
  const winner = r1.status === 200 ? n1 : n2;
  const loser = r1.status === 200 ? n2 : n1;
  assert.equal(fs.existsSync(`${config.authFile}.tmp`), false);
  assert.equal(password.isScryptHash(readAuthFile().hash), true);
  assert.equal((await guard.authenticate(winner)).ok, true);
  assert.equal((await guard.authenticate(loser)).ok, false);
  assert.equal((await guard.authenticate(a.current)).ok, false);
});

// ── audit และ log ────────────────────────────────────────────────────────────
function auditRows(action) {
  return statsDb.queryAudit({ action, limit: 50 }).rows;
}

test('audit: auth.password-change ok/fail มี เหตุผลสั้น และไม่มีค่ารหัสทั้งเก่า/ใหม่/ผิด ในทั้งตาราง', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  const wrong = rnd('wrongpw'); const bad = rnd('badnew').slice(0, 5); const good = rnd('goodnew');
  await a.change(cookie, { current: wrong, next: good });
  await a.change(cookie, { current: a.current, next: bad });
  const ok = await a.change(cookie, { current: a.current, next: good });
  assert.equal(ok.status, 200);
  const rows = auditRows('auth.password-change');
  const results = rows.map((r) => r.result).sort();
  assert.ok(results.includes('ok'));
  assert.ok(results.filter((x) => x === 'fail').length >= 2);
  const reasons = rows.map((r) => (r.detail ? JSON.parse(r.detail).reason : null)).filter(Boolean);
  assert.ok(reasons.includes('bad-current') && reasons.includes('invalid-new'));
  const dump = JSON.stringify(statsDb.queryAudit({ limit: 500 }).rows);
  for (const secret of [wrong, a.current, good, bad]) assert.equal(dump.includes(secret), false);
});

test('audit: ถูกล็อกด้วย limiter → บันทึก denied (auth.password-change-locked)', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  for (let i = 0; i < 5; i++) await a.change(cookie, { current: rnd('wrong'), next: rnd('new') });
  await a.change(cookie, { current: a.current, next: rnd('new') });
  const rows = auditRows('auth.password-change-locked');
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].result, 'denied');
});

test('log ไม่มีรหัสผ่านใด ๆ (เก่า/ใหม่/ผิด) ตลอดทุกเส้นทาง', async (t) => {
  const lines = [];
  const spies = ['info', 'warn', 'error'].map((k) => { const o = logger[k]; logger[k] = (...args) => lines.push(args.map(String).join(' ')); return [k, o]; });
  t.after(() => spies.forEach(([k, o]) => { logger[k] = o; }));
  const a = await startApp(t);
  const cookie = await a.login();
  const wrong = rnd('wrongpw'); const good = rnd('goodnew');
  await a.change(cookie, { current: wrong, next: good });
  await a.change(cookie, { current: a.current, next: 'short' });
  await a.change(cookie, { current: a.current, next: good });
  const all = lines.join('\n');
  for (const secret of [wrong, a.current, good]) assert.equal(all.includes(secret), false);
});

// ── เสริมหลัง mutation check ───────────────────────────────────────────────────
test('validateNewPassword: ตัวอักษรนอก BMP (emoji) ซ้ำทั้งสายก็ถูกปฏิเสธ (นับเป็นอักขระ ไม่ใช่ UTF-16 unit)', () => {
  assert.notEqual(password.validateNewPassword('😀'.repeat(13)), null);
  assert.equal(password.validateNewPassword('😀'.repeat(12) + '😁'), null);
});

test('validateNewPassword: ยาว 12 พอดีผ่าน, 11 ไม่ผ่าน', () => {
  assert.equal(password.validateNewPassword('abcdefghijkl'), null);
  assert.notEqual(password.validateNewPassword('abcdefghijk'), null);
});

test('hashOpts ที่ฉีดเข้า factory ถูกใช้จริง (hash ที่เก็บมี N=2^10 ตามค่าเบาของเทสต์ ไม่ใช่ค่า production)', async (t) => {
  const a = await startApp(t);
  const cookie = await a.login();
  assert.equal((await a.change(cookie, { current: a.current, next: rnd('new') })).status, 200);
  assert.match(readAuthFile().hash, /^scrypt\$1024\$8\$1\$/);
});

test('สำเร็จติดกันเกินโควตา (6 ครั้ง) ได้หมด — สำเร็จไม่กินโควตา limiter', async (t) => {
  const a = await startApp(t);
  let cookie = await a.login();
  let cur = a.current;
  for (let i = 0; i < 6; i++) {
    const next = rnd(`n${i}`);
    const res = await a.change(cookie, { current: cur, next });
    assert.equal(res.status, 200, `ครั้งที่ ${i + 1}`);
    cookie = res.headers.get('set-cookie').split(';')[0];
    cur = next;
  }
});

test('limiter ไม่ผูก IP แม้ req.ip ต่างกันจริง (trust proxy): X-Forwarded-For ต่างกัน นับรวมก้อนเดียว', async (t) => {
  const { createPasswordChangeLimiter } = require('../middleware/login-limit');
  const app = express();
  app.set('trust proxy', true);
  const seenIps = new Set();
  app.post('/p', (req, res, next) => { seenIps.add(req.ip); next(); }, createPasswordChangeLimiter({ max: 3, windowMs: 60000 }), (req, res) => res.status(403).json({ error: 'x' }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const post = (ip) => fetch(`http://127.0.0.1:${server.address().port}/p`, { method: 'POST', headers: { 'X-Forwarded-For': ip } });
  const codes = [];
  for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) codes.push((await post(ip)).status);
  assert.equal(seenIps.size, 4, 'ต้อง simulate IP ต่างกันได้จริง');
  assert.deepEqual(codes, [403, 403, 403, 429]);
});
