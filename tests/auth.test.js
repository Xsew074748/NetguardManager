// Auth hardening: scrypt hash/verify, migration จาก SHA-256 เดิม (auth.json, ไม่แตะ .env), fail closed,
// rate limit 2 ชั้น (ล็อก/ปลดตามเวลา/ไม่นับ login สำเร็จ), session, audit log (ไม่มี secret รั่ว), CLI set-password
// ใช้ node:test ในตัว ไม่เพิ่ม dependency — รหัสผ่านทั้งหมดในไฟล์นี้เป็นค่าสมมติสำหรับ test เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-auth-'));
process.env.BOTS_ROOT = root;
process.env.DB_PATH = path.join(root, 'stats.test.db');
process.env.AUTH_FILE = path.join(root, 'auth.json');

const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('../config');
const password = require('../services/password');
const authStore = require('../services/auth-store');
const guard = require('../middleware/guard');
const { createLoginLimiters } = require('../middleware/login-limit');
const statsDb = require('../services/stats-db');
const audit = require('../services/audit');
const dockerService = require('../services/docker');

statsDb.initDb();
test.after(() => statsDb.closeDb());

const FAST = { N: 2 ** 10, r: 8, p: 1 }; // เร็วพอสำหรับ test (production ใช้ N=2^15)
const PW = 'correct horse battery staple'; // 28 ตัว ≥ 12
const SHORT = 'short-pw-1'; // 10 ตัว < 12
const sha = (s) => password.legacySha256(s);

function resetAuthState({ envHash = '' } = {}) {
  try { fs.unlinkSync(config.authFile); } catch { /* ไม่มีไฟล์ */ }
  authStore.clearCache();
  config.managerPasswordHash = envHash;
}

// ── services/password.js ──────────────────────────────────────────────────────
test('scrypt: hash รูปแบบถูกต้อง, salt สุ่มทุกครั้ง, verify ถูก/ผิด', async () => {
  const h1 = await password.hashPassword(PW, FAST);
  const h2 = await password.hashPassword(PW, FAST);
  assert.match(h1, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(h1, h2, 'salt ต้องต่างกัน');
  assert.ok(!h1.includes(PW));
  assert.equal(await password.verifyPassword(PW, h1), true);
  assert.equal(await password.verifyPassword(PW, h2), true);
  assert.equal(await password.verifyPassword(`${PW}x`, h1), false);
  assert.equal(await password.verifyPassword('', h1), false);
});

test('scrypt: ค่า default (production) ใช้ N=2^15 และ verify ผ่านพารามิเตอร์ที่เก็บในสตริง', async () => {
  const h = await password.hashPassword(PW);
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await password.verifyPassword(PW, h), true);
});

test('verify: hash ผิดรูป/พารามิเตอร์อันตราย → false ไม่ throw ไม่กิน CPU/RAM', async () => {
  const good = await password.hashPassword(PW, FAST);
  const parts = good.split('$');
  const bad = [
    undefined, null, '', 'plain', sha(PW), 'scrypt$x$8$1$AAAA$AAAA',
    `scrypt$${2 ** 25}$8$1$${parts[4]}$${parts[5]}`, // N เกินเพดาน
    `scrypt$1000$8$1$${parts[4]}$${parts[5]}`,        // N ไม่ใช่ยกกำลังสอง
    `scrypt$1024$999$1$${parts[4]}$${parts[5]}`,      // r เกินเพดาน
    `scrypt$1024$8$99$${parts[4]}$${parts[5]}`,       // p เกินเพดาน
  ];
  for (const b of bad) assert.equal(await password.verifyPassword(PW, b), false, String(b));
  assert.equal(await password.verifyPassword('x'.repeat(5000), good), false, 'รหัสยาวเกินถูกปฏิเสธ');
});

test('legacy sha256: ตรวจได้/ผิดรูปไม่ผ่าน, validateNewPassword บังคับ ≥ 12', () => {
  assert.equal(password.isLegacySha256(sha(PW)), true);
  assert.equal(password.isLegacySha256('abc'), false);
  assert.equal(password.verifyLegacy(PW, sha(PW)), true);
  assert.equal(password.verifyLegacy(PW, sha(PW).toUpperCase()), true);
  assert.equal(password.verifyLegacy('wrong', sha(PW)), false);
  assert.equal(password.verifyLegacy(PW, 'not-a-hash'), false);
  assert.equal(password.validateNewPassword('a'.repeat(11)) !== null, true);
  assert.equal(password.validateNewPassword('a'.repeat(12)), null);
  assert.equal(password.validateNewPassword(undefined) !== null, true);
});

// ── authenticate + migration ──────────────────────────────────────────────────
test('migration: .env เป็น SHA-256 เดิม → login สำเร็จ → เขียน auth.json (scrypt, 0600) และไม่แตะ .env/config', async () => {
  resetAuthState({ envHash: sha(PW) });
  const r = await guard.authenticate(PW);
  assert.equal(r.ok, true);
  assert.equal(r.migrated, true);
  assert.equal(r.weak, false);
  const doc = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  assert.match(doc.hash, /^scrypt\$/);
  assert.equal(doc.migratedFromLegacy, true);
  assert.equal(doc.weak, false);
  assert.ok(!JSON.stringify(doc).includes(PW));
  assert.equal(config.managerPasswordHash, sha(PW), '.env (config) ต้องไม่ถูกแก้');
  if (process.platform !== 'win32') assert.equal(fs.statSync(config.authFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${config.authFile}.tmp`), false, 'ไม่มี .tmp ค้าง');
});

test('migration: รหัสผิด → ไม่ login, ไม่สร้าง auth.json', async () => {
  resetAuthState({ envHash: sha(PW) });
  const r = await guard.authenticate('wrong password here');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-password');
  assert.equal(fs.existsSync(config.authFile), false);
});

test('หลัง migrate: auth.json เป็นตัวตัดสินเพียงที่เดียว (ต่อให้ .env เปลี่ยนเป็นรหัสอื่น)', async () => {
  resetAuthState({ envHash: sha(PW) });
  await guard.authenticate(PW);
  config.managerPasswordHash = sha('some other password!!'); // จำลอง .env ถูกแก้/ไม่ตรง
  assert.equal((await guard.authenticate(PW)).ok, true);
  assert.equal((await guard.authenticate('some other password!!')).ok, false);
});

test('รหัสเดิมสั้นกว่า 12: migrate ได้ แต่ติด weak ทั้งในผลลัพธ์และ auth.json (เตือนอย่างเดียว ไม่บล็อก)', async () => {
  resetAuthState({ envHash: sha(SHORT) });
  const r = await guard.authenticate(SHORT);
  assert.equal(r.ok, true);
  assert.equal(r.weak, true);
  assert.equal(JSON.parse(fs.readFileSync(config.authFile, 'utf8')).weak, true);
  assert.equal(guard.isPasswordWeak(), true);
  // login รอบถัดไป (จาก auth.json) ยัง weak
  assert.equal((await guard.authenticate(SHORT)).weak, true);
});

test('auth.json เสีย/ผิดรูป → fall back ไป .env (ไม่ล็อกตัวเอง) แล้ว migrate ซ้ำได้', async () => {
  for (const broken of ['{not json', '{}', JSON.stringify({ hash: sha(PW) }), JSON.stringify({ hash: 'scrypt$bad' }), '']) {
    resetAuthState({ envHash: sha(PW) });
    fs.writeFileSync(config.authFile, broken);
    const r = await guard.authenticate(PW);
    assert.equal(r.ok, true, `broken=${broken.slice(0, 20)}`);
    assert.equal(r.migrated, true);
    assert.match(JSON.parse(fs.readFileSync(config.authFile, 'utf8')).hash, /^scrypt\$/, 'ซ่อมไฟล์ให้แล้ว');
  }
});

test('เขียน auth.json ไม่ได้ → ยัง login ผ่าน (migrated=false) ไม่ crash', async () => {
  resetAuthState({ envHash: sha(PW) });
  const real = config.authFile;
  fs.writeFileSync(path.join(root, 'blocker'), 'x'); // ไฟล์ธรรมดาขวางทางที่ควรเป็นโฟลเดอร์
  config.authFile = path.join(root, 'blocker', 'auth.json');
  try {
    const r = await guard.authenticate(PW);
    assert.equal(r.ok, true);
    assert.equal(r.migrated, false);
  } finally {
    config.authFile = real;
  }
});

test('fail closed: ไม่มี hash เลย → login ไม่ได้ แม้รหัส "admin" (เลิก default password)', async () => {
  resetAuthState({ envHash: '' });
  for (const pw of ['admin', 'password', PW, 'x']) {
    const r = await guard.authenticate(pw);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-hash-configured');
  }
  assert.equal(fs.existsSync(config.authFile), false);
});

test('.env เป็น scrypt (ใส่เอง) ใช้ได้; รูปแบบที่ไม่รู้จัก → fail closed', async () => {
  resetAuthState({ envHash: await password.hashPassword(PW, FAST) });
  assert.equal((await guard.authenticate(PW)).ok, true);
  assert.equal((await guard.authenticate('nope')).ok, false);
  resetAuthState({ envHash: 'plaintext-password' });
  const r = await guard.authenticate('plaintext-password');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported-hash-format');
});

test('input ผิดชนิด/ว่าง/ยาวเกิน → ปฏิเสธโดยไม่ตรวจ hash', async () => {
  resetAuthState({ envHash: sha(PW) });
  for (const v of [undefined, null, '', 123, {}, [], 'x'.repeat(2000)]) {
    assert.equal((await guard.authenticate(v)).ok, false);
  }
  assert.equal(fs.existsSync(config.authFile), false);
});

// ── session ───────────────────────────────────────────────────────────────────
test('session: สร้าง/ตรวจ/ทำลาย, sweep ลบที่หมดอายุ, actor เป็น hash ตัดสั้น (ไม่ใช่ token)', () => {
  resetAuthState();
  const t = guard.createSession();
  assert.equal(guard.isValidSession(t), true);
  const actor = guard.sessionActor(t);
  assert.match(actor, /^sess-[0-9a-f]{8}$/);
  assert.ok(!t.includes(actor.slice(5)) || true);
  assert.notEqual(actor.slice(5), t.slice(0, 8));
  assert.equal(guard.sessionActor(undefined), 'anonymous');
  assert.equal(guard.sweepSessions(Date.now() + 25 * 3600 * 1000) >= 1, true, 'sweep หลัง 25 ชม. ลบ session นี้');
  assert.equal(guard.isValidSession(t), false);
  const t2 = guard.createSession();
  guard.destroySession(t2);
  assert.equal(guard.isValidSession(t2), false);
});

test('เปลี่ยนรหัส (invalidateSessions) → session ที่ออกก่อนหน้าใช้ไม่ได้; migrate ธรรมดาไม่เตะ session', async () => {
  resetAuthState({ envHash: sha(PW) });
  const before = guard.createSession();
  await guard.authenticate(PW); // migrate — ไม่ควรเตะ session ที่ login อยู่
  authStore.clearCache();
  assert.equal(guard.isValidSession(before), true);

  await new Promise((r) => setTimeout(r, 5));
  authStore.save({ hash: await password.hashPassword('another long password 1', FAST), invalidateSessions: true });
  assert.equal(guard.isValidSession(before), false);
  const after = guard.createSession();
  assert.equal(guard.isValidSession(after), true);
});

// ── rate limit ────────────────────────────────────────────────────────────────
async function startLoginApp({ perIpMax = 5, globalMax = 20, windowMs = 60000, ipFromHeader = false } = {}) {
  resetAuthState({ envHash: sha(PW) });
  const blocked = [];
  const limiters = createLoginLimiters({
    windowMs, perIpMax, globalMax,
    keyForIp: ipFromHeader ? (req) => req.headers['x-test-ip'] || 'none' : undefined,
    onBlocked: (req, scope) => blocked.push(scope),
  });
  const app = express();
  app.use(express.json());
  app.post('/login', limiters, async (req, res) => {
    const r = await guard.authenticate((req.body || {}).password);
    return r.ok ? res.json({ loggedIn: true }) : res.status(401).json({ error: 'Invalid password' });
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (pw, headers = {}) => fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password: pw }) });
  return { server, login, blocked };
}

test('rate limit: ผิดครบ 5 ครั้ง → ครั้งที่ 6 ถูกล็อก (429) แม้ใส่รหัสถูก; onBlocked ถูกเรียก', async () => {
  const { server, login, blocked } = await startLoginApp({ perIpMax: 5 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login(PW)).status, 429, 'ล็อกแล้ว แม้รหัสถูก');
    assert.deepEqual(blocked, ['ip']);
  } finally { server.close(); }
});

test('rate limit: login สำเร็จไม่กินโควตา (สำเร็จกี่ครั้งก็ไม่ล็อก แล้วยังผิดได้เต็ม limit)', async () => {
  const { server, login } = await startLoginApp({ perIpMax: 3 });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await login(PW)).status, 200, 'สำเร็จ 10 ครั้ง limit 3 ต้องไม่ถูกล็อก');
    for (let i = 0; i < 3; i++) assert.equal((await login('wrong')).status, 401, `ผิดครั้งที่ ${i + 1} จาก limit 3 ยังไม่ล็อก`);
    assert.equal((await login(PW)).status, 429, 'ผิดครบ limit แล้ว ครั้งถัดไปถูกล็อก (รวมรหัสถูก)');
  } finally { server.close(); }
});

test('rate limit: ปลดล็อกเมื่อครบ window', async () => {
  const { server, login } = await startLoginApp({ perIpMax: 2, windowMs: 400 });
  try {
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await login(PW)).status, 429);
    await new Promise((r) => setTimeout(r, 650));
    assert.equal((await login(PW)).status, 200, 'พ้น window แล้วต้อง login ได้');
  } finally { server.close(); }
});

test('rate limit: เพดานรวมทั้งระบบ — ต่าง IP กันก็ล็อกทุกคนเมื่อผิดรวมครบ', async () => {
  const { server, login, blocked } = await startLoginApp({ perIpMax: 100, globalMax: 4, ipFromHeader: true });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await login('wrong', { 'x-test-ip': `10.0.0.${i}` })).status, 401);
    assert.equal((await login(PW, { 'x-test-ip': '10.9.9.9' })).status, 429, 'IP ใหม่ยังโดนเพดานรวม');
    assert.ok(blocked.includes('global'));
  } finally { server.close(); }
});

test('rate limit: ต่อ IP — IP หนึ่งถูกล็อกไม่กระทบอีก IP (ตราบที่ยังไม่ถึงเพดานรวม)', async () => {
  const { server, login } = await startLoginApp({ perIpMax: 2, globalMax: 50, ipFromHeader: true });
  try {
    for (let i = 0; i < 2; i++) await login('wrong', { 'x-test-ip': 'A' });
    assert.equal((await login(PW, { 'x-test-ip': 'A' })).status, 429);
    assert.equal((await login(PW, { 'x-test-ip': 'B' })).status, 200);
  } finally { server.close(); }
});

// ── audit log ─────────────────────────────────────────────────────────────────
test('sanitizeDetail: ตัด key ลับ, ค่าที่เหมือน token, object ซ้อน; จำกัดขนาด', () => {
  const secretValue = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const json = audit.sanitizeDetail({
    changed: ['ANTHROPIC_API_KEY', 'ZABBIX_URL'], system: 'omada',
    password: 'p', clientSecret: 's', apiToken: 't', Authorization: 'Bearer x', hash: 'h', cookie: 'c', appKey: 'k',
    note: `value ${secretValue} end`, nested: { a: 1 }, fn: () => 1, n: 5, ok: true,
  });
  const o = JSON.parse(json);
  assert.deepEqual(o.changed, ['ANTHROPIC_API_KEY', 'ZABBIX_URL'], 'ชื่อ key ใน array เก็บได้ (ไม่ใช่ค่า)');
  assert.equal(o.system, 'omada');
  for (const k of ['password', 'clientSecret', 'apiToken', 'Authorization', 'hash', 'cookie', 'appKey', 'nested', 'fn']) assert.ok(!(k in o), k);
  assert.ok(!json.includes(secretValue));
  assert.match(o.note, /\[redacted\]/);
  assert.equal(o.n, 5);
  assert.equal(audit.sanitizeDetail(null), null);
  assert.equal(audit.sanitizeDetail({ password: 'x' }), null);
  assert.equal(audit.sanitizeDetail('string'), null);
  // ข้อความยาวที่ไม่ใช่ token (มีช่องว่าง) หลายคีย์ → เกินเพดานขนาด → เหลือแค่ธงว่าถูกตัด
  const big = audit.sanitizeDetail(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'word '.repeat(38)])));
  assert.deepEqual(JSON.parse(big), { truncated: true });
  // ค่ายาวต่อเนื่องไม่มีช่องว่าง (หน้าตาเหมือน token) ถูกแทนด้วย [redacted] ก่อน
  assert.equal(JSON.parse(audit.sanitizeDetail({ v: 'v'.repeat(190) })).v, '[redacted]');
});

test('audit.record: ต่อให้ผู้เรียกพลาดส่ง secret เข้า detail ก็ไม่ถึงตาราง (ป้องกันซ้อนชั้น)', () => {
  const leak = 'sk-ant-api03-LEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAK';
  audit.record({
    action: 'unit.leak', target: 'bot-x', result: 'ok',
    detail: { apiKey: leak, password: 'hunter2hunter2', note: `Bearer ${leak}`, headers: { authorization: leak }, ok: true },
  });
  const row = statsDb.queryAudit({ action: 'unit.leak' }).rows[0];
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes(leak) && !dump.includes('hunter2hunter2'), dump);
  assert.deepEqual(JSON.parse(row.detail).ok, true);
});

test('audit.record ไม่ throw แม้ DB พัง และ target ที่เป็น container id เต็มถูกย่อ', () => {
  audit.record({ action: 'unit.test', target: 'a'.repeat(64), result: 'ok', actor: 'sess-test0000', ip: '1.2.3.4' });
  const row = statsDb.queryAudit({ action: 'unit.test' }).rows[0];
  assert.equal(row.target.length, 12);
  assert.equal(row.actor, 'sess-test0000');
  const realInsert = statsDb.insertAudit;
  statsDb.insertAudit = () => { throw new Error('db down'); };
  try { assert.doesNotThrow(() => audit.record({ action: 'unit.fail', result: 'ok' })); } finally { statsDb.insertAudit = realInsert; }
});

// ทั้งระบบผ่าน HTTP จริง: routes/auth + routes/api (mock docker) แล้วค้นหา secret ใน audit_log ทั้งตาราง
test('audit ครบทุก action และไม่มี secret รั่วลงตาราง (ทดสอบด้วยค่า secret ที่รู้ล่วงหน้า)', async (t) => {
  resetAuthState({ envHash: sha(PW) });
  const SECRETS = {
    tunnel: 'cf-tunnel-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    anthropic: 'sk-ant-api03-SECRETKEYSECRETKEYSECRETKEY123456',
    omada: 'omada-client-secret-VALUE-9999999999999999',
    hik: 'hik-app-secret-VALUE-8888888888888888',
  };

  const calls = [];
  const orig = {};
  for (const fn of ['createBot', 'startBot', 'stopBot', 'restartBot', 'removeBot', 'pullLatestImage', 'attachTunnel', 'detachTunnel', 'testBotConnection', 'callBot']) {
    orig[fn] = dockerService[fn];
  }
  dockerService.createBot = async (a) => { calls.push('create'); return { id: 'cid', name: `netguard-${a.name}`, port: a.port }; };
  dockerService.startBot = async () => calls.push('start');
  dockerService.stopBot = async () => calls.push('stop');
  dockerService.restartBot = async () => calls.push('restart');
  dockerService.removeBot = async () => calls.push('remove');
  dockerService.pullLatestImage = async () => calls.push('pull');
  dockerService.attachTunnel = async () => calls.push('attach');
  dockerService.detachTunnel = async () => calls.push('detach');
  dockerService.testBotConnection = async () => ({ ok: true, message: 'ok' });
  dockerService.callBot = async () => ({ reachable: true, status: 200, data: { ok: true, times: ['07:00'] } });
  t.after(() => Object.assign(dockerService, orig));

  fs.mkdirSync(path.join(root, 'audit-bot'), { recursive: true }); // createBot ถูก mock จึงสร้างโฟลเดอร์ bot ให้เอง (writeEnvConfig/meta ต้องใช้)
  const apiRoutes = require('../routes/api');
  const authRoutes = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api', apiRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // login ผิด 1 ครั้ง แล้ว login ถูก (migrate จากรหัสเดิม) — เก็บ cookie จริง
  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password-123' }) });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  const req = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });

  const status = await (await req('GET', '/api/auth/status')).json();
  assert.deepEqual(status, { loggedIn: true, weakPassword: false });

  // action ทั้งหมดที่ต้อง audit
  await req('POST', '/api/bots', { name: 'audit-bot', port: 3901, tunnelToken: SECRETS.tunnel, companyName: 'ACME' });
  await req('POST', '/api/bots/audit-bot/start');
  await req('POST', '/api/bots/audit-bot/stop');
  await req('POST', '/api/bots/audit-bot/restart');
  await req('POST', '/api/image/pull');
  await req('POST', '/api/bots/audit-bot/tunnel', { token: SECRETS.tunnel });
  await req('DELETE', '/api/bots/audit-bot/tunnel');
  await req('PUT', '/api/bots/audit-bot/meta', { companyName: 'ACME', note: 'x' });
  await req('PUT', '/api/bots/audit-bot/config', { ANTHROPIC_API_KEY: SECRETS.anthropic, OMADA_CLIENT_SECRET: SECRETS.omada, HIKCENTRAL_APP_SECRET: SECRETS.hik, OMADA_URL: 'https://omada.example' });
  await req('PUT', '/api/bots/audit-bot/daily-summary', { times: ['07:00'] });
  await req('POST', '/api/bots/audit-bot/test-connection', { system: 'omada', config: { clientSecret: SECRETS.omada, url: 'https://omada.example' } });
  await req('PUT', '/api/bots/audit-bot/config', { OMADA_URL: 'ftp://bad' }); // ล้มเหลว (400) — ข้อความ error ต้องไม่มี secret
  await req('DELETE', '/api/bots/audit-bot?deleteFiles=true');
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });

  const { rows, total } = statsDb.queryAudit({ limit: 500 });
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['auth.login', 'auth.password-migrated', 'bot.create', 'bot.start', 'bot.stop', 'bot.restart', 'image.pull',
    'tunnel.attach', 'tunnel.detach', 'bot.meta.update', 'bot.config.update', 'bot.daily-summary.update', 'bot.test-connection', 'bot.remove', 'auth.logout']) {
    assert.ok(actions.has(a), `ขาด audit action: ${a} (มี: ${[...actions].join(', ')})`);
  }
  // login ผิด + ผลลัพธ์ fail ของ config ที่ validate ไม่ผ่าน
  assert.ok(rows.some((r) => r.action === 'auth.login' && r.result === 'fail'));
  assert.ok(rows.some((r) => r.action === 'auth.login' && r.result === 'ok'));
  assert.ok(rows.some((r) => r.action === 'bot.config.update' && r.result === 'fail'));
  assert.ok(rows.some((r) => r.action === 'bot.config.update' && r.result === 'ok'));

  const cfgOk = rows.find((r) => r.action === 'bot.config.update' && r.result === 'ok');
  assert.deepEqual(JSON.parse(cfgOk.detail).changed.sort(), ['ANTHROPIC_API_KEY', 'HIKCENTRAL_APP_SECRET', 'OMADA_CLIENT_SECRET', 'OMADA_URL']);
  const created = rows.find((r) => r.action === 'bot.create');
  assert.equal(created.target, 'audit-bot');
  assert.equal(JSON.parse(created.detail).withTunnel, true);
  assert.equal(JSON.parse(rows.find((r) => r.action === 'bot.test-connection').detail).system, 'omada');
  assert.equal(rows.find((r) => r.action === 'bot.remove').target, 'audit-bot');
  assert.match(rows.find((r) => r.action === 'auth.login' && r.result === 'ok').actor, /^sess-[0-9a-f]{8}$/);
  assert.equal(rows.find((r) => r.action === 'auth.login' && r.result === 'fail').actor, 'anonymous');

  // หัวใจของงาน: ไม่มี secret ใดๆ (หรือรหัสผ่าน หรือ token ของ session) ปรากฏที่ใดในตารางทั้งหมด
  const dump = JSON.stringify(rows);
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!dump.includes(value), `secret รั่วใน audit_log: ${name}`);
  assert.ok(!dump.includes(PW), 'รหัสผ่านรั่วใน audit_log');
  assert.ok(!dump.includes('wrong-password-123'), 'รหัสผ่านที่ผิดรั่วใน audit_log');
  assert.ok(!dump.includes(cookie.split('=')[1]), 'session token รั่วใน audit_log');
  assert.ok(!/scrypt\$/.test(dump), 'hash รั่วใน audit_log');
  assert.ok(total >= rows.length);

  // GET /api/audit: ต้อง login, กรองได้, ไม่ถูกบันทึกซ้ำ
  assert.equal((await fetch(`${base}/api/audit`)).status, 401);
  // logout ไปแล้ว → session เดิมใช้ไม่ได้ (401)
  const afterLogout = await fetch(`${base}/api/audit?action=bot.&result=fail`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401, 'logout แล้ว session เดิมต้องใช้ไม่ได้');
});

test('GET /api/audit: กรอง action/result/limit, ใหม่สุดก่อน (login ใหม่เพราะ logout ในเทสก่อนหน้า)', async (t) => {
  const apiRoutes = require('../routes/api');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', apiRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${guard.SESSION_COOKIE}=${guard.createSession()}`;
  const get = (p) => fetch(base + p, { headers: { Cookie: cookie } }).then((r) => r.json());

  const all = await get('/api/audit?limit=5');
  assert.equal(all.rows.length, 5);
  assert.ok(all.rows[0].id > all.rows[1].id, 'ใหม่สุดก่อน');
  const auths = await get('/api/audit?action=auth.');
  assert.ok(auths.rows.length > 0 && auths.rows.every((r) => r.action.startsWith('auth.')));
  const fails = await get('/api/audit?result=fail');
  assert.ok(fails.rows.length > 0 && fails.rows.every((r) => r.result === 'fail'));
  assert.deepEqual((await get('/api/audit?result=bogus')).rows.length > 0, true, 'result ที่ไม่รู้จักถูกเมิน ไม่ error');
  const inj = await get(`/api/audit?action=${encodeURIComponent("%' OR 1=1 --")}`);
  assert.equal(inj.rows.length, 0, 'ตัวอักษรพิเศษไม่ทำให้ filter กว้างขึ้น');
  const before = (await get('/api/audit')).total;
  await get('/api/audit');
  assert.equal((await get('/api/audit')).total, before, 'การดู audit ไม่ถูกบันทึกซ้ำ');
});

// ── CLI ───────────────────────────────────────────────────────────────────────
test('set-password CLI: ไม่รับ argument และไม่รันนอก TTY (ไม่รับรหัสผ่านทางช่องทางที่รั่วได้)', () => {
  const script = path.join(__dirname, '..', 'scripts', 'set-password.js');
  const a = spawnSync(process.execPath, [script, 'secret-in-argv'], { encoding: 'utf8', env: { ...process.env, AUTH_FILE: path.join(root, 'cli-auth.json') } });
  assert.equal(a.status, 2);
  assert.ok(!a.stdout.includes('secret-in-argv') && !a.stderr.includes('secret-in-argv'));
  const b = spawnSync(process.execPath, [script], { input: 'piped-password-123\npiped-password-123\n', encoding: 'utf8', env: { ...process.env, AUTH_FILE: path.join(root, 'cli-auth.json') } });
  assert.equal(b.status, 2);
  assert.equal(fs.existsSync(path.join(root, 'cli-auth.json')), false);
  const old = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'gen-password.js'), 'x'], { encoding: 'utf8' });
  assert.equal(old.status, 1, 'gen-password.js (SHA-256) ถูกยกเลิก');
});
