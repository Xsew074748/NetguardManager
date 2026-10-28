'use strict';
// ทดสอบ index.js "ตัวจริง" ทั้งก้อน (networkGuard, express.static, ลำดับ mount) โดย spawn เป็น child process
// แล้วยิง HTTP จริง: login → POST /api/auth/password (cookie + X-Requested-With + Origin) → ตรวจ audit_log ด้วย better-sqlite3 แบบ readonly
// ข้อมูลทั้งหมดอยู่ในโฟลเดอร์ temp; รหัสทดสอบสุ่มขึ้นเอง; ไม่เชื่อม docker.sock จริง (ข้ามทั้งไฟล์ถ้าเครื่องมี socket นี้)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const SKIP = fs.existsSync('/var/run/docker.sock') ? 'พบ /var/run/docker.sock จริง — ไม่รัน index.js จริงเพื่อไม่ให้ poller คุยกับ docker' : false;

const rnd = (tag) => `${tag}-${crypto.randomBytes(9).toString('hex')}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let child;
let port;
let tmp;
let db;
let output = '';
const pw0 = rnd('pw0');

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const cookieOf = (res) => {
  const sc = res.headers['set-cookie'];
  const m = sc && sc.map((c) => c.split(';')[0]).find((c) => c.startsWith('ng_session='));
  return m || null;
};
const origin = () => `http://127.0.0.1:${port}`;
const XRW = { 'X-Requested-With': 'fetch' };

function auditRows(action) {
  return db.prepare('SELECT result, detail FROM audit_log WHERE action = ? ORDER BY id').all(action)
    .map((r) => ({ result: r.result, detail: r.detail ? JSON.parse(r.detail) : {} }));
}

function changePassword(cookie, body, extra = {}) {
  return request('POST', '/api/auth/password', {
    headers: { Cookie: cookie, ...XRW, Origin: origin(), ...extra },
    body,
  });
}

test.before(async () => {
  if (SKIP) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-app-it-'));
  fs.mkdirSync(path.join(tmp, 'bots'));
  port = await freePort();
  const dbPath = path.join(tmp, 'stats.db');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    cwd: tmp, // dotenv อ่าน .env จาก cwd → ไม่เจอ .env ของจริง
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      AUTH_FILE: path.join(tmp, 'auth.json'),
      BOTS_ROOT: path.join(tmp, 'bots'),
      POLLER_BOTS: 'no-such-bot',
      MANAGER_PASSWORD_HASH: sha256(pw0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server ไม่ขึ้นภายใน 20 วินาที')), 20000);
    const check = setInterval(() => {
      if (output.includes('listening on port')) { clearInterval(check); clearTimeout(timer); resolve(); }
    }, 50);
    child.once('exit', (code) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server จบเอง code=${code}`)); });
  });
  db = new Database(dbPath, { readonly: true });
});

test.after(async () => {
  if (db) { try { db.close(); } catch { /* ปิดแล้ว */ } }
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 6000).unref();
    });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmp) {
    // Windows ยังถือไฟล์ stats.db อยู่ชั่วครู่หลัง child ตาย (EBUSY/ENOTEMPTY/EPERM) → ลองใหม่ก่อน; ครอบเฉพาะขั้นลบโฟลเดอร์ชั่วคราวนี้เท่านั้น
    // ลบไม่ได้จริงก็ log ให้เห็น (ไม่เงียบ) แต่ไม่ทำให้ชุดเทสต์ล้ม — error ของตัวเทสต์/ขั้นอื่นใน hook ไม่ถูกกลืน
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      console.error(`app-integration: ลบโฟลเดอร์ชั่วคราวไม่สำเร็จ (${err.code || err.message}): ${tmp}`);
    }
  }
});

test('static: เสิร์ฟ modals.js / api.js / password-form.js / index.html ถูกต้องพร้อม ETag และ max-age=0', { skip: SKIP }, async () => {
  const modals = await request('GET', '/js/modals.js');
  assert.equal(modals.status, 200);
  assert.match(modals.text, /async function submitChangePassword/);
  assert.match(modals.headers['cache-control'], /max-age=0/);
  assert.ok(modals.headers.etag);

  const api = await request('GET', '/js/api.js');
  assert.equal(api.status, 200);
  assert.match(api.text, /function apiChangePassword/);
  assert.match(api.text, /\/api\/auth\/password/);

  const form = await request('GET', '/js/password-form.js');
  assert.equal(form.status, 200);
  assert.match(form.text, /function validatePasswordForm/);

  // ไฟล์ที่เสิร์ฟต้องเหมือนไฟล์ในดิสก์ทุกไบต์
  for (const [url, file] of [['/js/modals.js', 'js/modals.js'], ['/js/api.js', 'js/api.js'], ['/js/password-form.js', 'js/password-form.js']]) {
    const r = await request('GET', url);
    assert.equal(r.text, fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), url);
  }
  // index.html ต้อง login ก่อน (ไม่มี cookie → เด้งไป login.html)
  const idx = await request('GET', '/');
  assert.equal(idx.status, 302);
  assert.equal(idx.headers.location, '/login.html');
});

test('POST /api/auth/password: ไม่มี cookie → 401 และไม่มีแถว audit', { skip: SKIP }, async () => {
  const before = auditRows('auth.password-change').length;
  const res = await request('POST', '/api/auth/password', { headers: { ...XRW, Origin: origin() }, body: { current: pw0, next: rnd('new') } });
  assert.equal(res.status, 401);
  assert.equal(auditRows('auth.password-change').length, before);
});

test('ลำดับเต็ม: login → CSRF/400/403 ทุกกรณี → 200 + audit → session เก่าถูกยกเลิก → 429', { skip: SKIP }, async () => {
  // login
  const login = await request('POST', '/api/auth/login', { headers: { ...XRW }, body: { password: pw0 } });
  assert.equal(login.status, 200);
  const cookie1 = cookieOf(login);
  assert.ok(cookie1, 'ต้องได้ cookie ng_session');
  const status = await request('GET', '/api/auth/status', { headers: { Cookie: cookie1 } });
  assert.equal(status.json.loggedIn, true);

  // CSRF: ไม่มี X-Requested-With → 403 + denied/csrf
  let res = await request('POST', '/api/auth/password', { headers: { Cookie: cookie1, Origin: origin() }, body: { current: pw0, next: rnd('n') } });
  assert.equal(res.status, 403);
  // CSRF: Origin ต่าง host → 403 + denied/csrf
  res = await changePassword(cookie1, { current: pw0, next: rnd('n') }, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  let rows = auditRows('auth.password-change');
  assert.deepEqual(rows.map((r) => [r.result, r.detail.reason]), [['denied', 'csrf'], ['denied', 'csrf']]);

  // 400: สั้นเกินไป / ซ้ำรหัสเดิม
  res = await changePassword(cookie1, { current: pw0, next: 'short' });
  assert.equal(res.status, 400);
  res = await changePassword(cookie1, { current: pw0, next: pw0 });
  assert.equal(res.status, 400);
  rows = auditRows('auth.password-change');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(2).map((r) => r.result), ['fail', 'fail']);

  // 403: รหัสเดิมผิด (ต้องไม่ใช่ 401) + แถว fail/bad-current
  res = await changePassword(cookie1, { current: rnd('wrong'), next: rnd('new') });
  assert.equal(res.status, 403);
  rows = auditRows('auth.password-change');
  assert.equal(rows.length, 5);
  assert.deepEqual([rows[4].result, rows[4].detail.reason], ['fail', 'bad-current']);

  // 200: สำเร็จ → cookie ใหม่ + แถว ok
  const pw1 = rnd('pw1');
  res = await changePassword(cookie1, { current: pw0, next: pw1 });
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, true);
  assert.equal(res.json.envHashStale, true);
  const cookie2 = cookieOf(res);
  assert.ok(cookie2 && cookie2 !== cookie1);
  rows = auditRows('auth.password-change');
  assert.equal(rows.length, 6);
  assert.equal(rows[5].result, 'ok');

  // ไม่มีรหัสใดหลุดลง audit_log ทั้งตาราง
  const all = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  for (const secret of [pw0, pw1]) assert.ok(!all.includes(secret), 'รหัสต้องไม่อยู่ใน audit_log');

  // session เก่าใช้ไม่ได้ ใหม่ใช้ได้
  const old = await request('GET', '/api/auth/status', { headers: { Cookie: cookie1 } });
  assert.equal(old.json.loggedIn, false);
  const fresh = await request('GET', '/api/auth/status', { headers: { Cookie: cookie2 } });
  assert.equal(fresh.json.loggedIn, true);
  assert.equal(fresh.json.envHashStale, true);

  // login ด้วยรหัสใหม่ผ่าน รหัสเก่าไม่ผ่าน
  const newLogin = await request('POST', '/api/auth/login', { headers: { ...XRW }, body: { password: pw1 } });
  assert.equal(newLogin.status, 200);
  const oldLogin = await request('POST', '/api/auth/login', { headers: { ...XRW }, body: { password: pw0 } });
  assert.equal(oldLogin.status, 401);

  // 429: รหัสเดิมผิดรวมเป็น 5 ครั้ง (มี 1 แล้ว) แล้วครั้งที่ 6 ถูกบล็อกแม้ใส่รหัสถูก
  for (let i = 0; i < 4; i += 1) {
    res = await changePassword(cookie2, { current: rnd('wrong'), next: rnd('new') });
    assert.equal(res.status, 403, `ครั้งที่ ${i + 2}`);
  }
  res = await changePassword(cookie2, { current: pw1, next: rnd('new') });
  assert.equal(res.status, 429);
  const locked = auditRows('auth.password-change-locked');
  assert.equal(locked.length, 1);
  assert.equal(locked[0].result, 'denied');
  // 429 ไม่ทำให้รหัสเปลี่ยน
  const still = await request('POST', '/api/auth/login', { headers: { ...XRW }, body: { password: pw1 } });
  assert.equal(still.status, 200);
});
