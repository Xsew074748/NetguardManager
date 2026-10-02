// เวลาแจ้งเตือนสรุปประจำวัน: validate + อ่าน/เขียน settings.json + route (ต้อง login) — ใช้ node:test ในตัว ไม่เพิ่ม dependency
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-bots-'));
process.env.BOTS_ROOT = root;
process.env.DB_PATH = path.join(root, 'stats.test.db');

const express = require('express');
const cookieParser = require('cookie-parser');
const guard = require('../middleware/guard');
const dockerService = require('../services/docker');
const svc = require('../services/daily-summary-config');
const apiRoutes = require('../routes/api');

const botDir = (n) => path.join(root, n, 'data');
const settingsOf = (n) => path.join(botDir(n), 'settings.json');

test('validateTimes: ถูกต้อง → เรียงลำดับ', () => {
  assert.deepEqual(svc.validateTimes(['17:00', '08:00', '00:00', '23:59']), { ok: true, times: ['00:00', '08:00', '17:00', '23:59'] });
});

for (const [name, input, re] of [
  ['24:00', ['24:00'], /รูปแบบ/], ['8:00 ไม่มีศูนย์นำ', ['8:00'], /รูปแบบ/], ['08:60', ['08:60'], /รูปแบบ/],
  ['ข้อความ', ['abc'], /รูปแบบ/], ['ตัวเลข', [800], /รูปแบบ/], ['null', [null], /รูปแบบ/],
  ['ว่าง', [], /อย่างน้อย 1/], ['ไม่ใช่ array', '08:00', /รายการ/], ['undefined', undefined, /รายการ/],
  ['ซ้ำ', ['08:00', '08:00'], /ซ้ำ/],
]) {
  test(`validateTimes: ไม่ผ่าน (${name})`, () => {
    const r = svc.validateTimes(input);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  });
}

test('writeTimes/readTimes: บันทึก atomic, เก็บ key อื่นใน settings.json ไว้, ไม่มี .tmp ค้าง', () => {
  const dir = botDir('shop-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsOf('shop-a'), JSON.stringify({ keepMe: 42 }));
  assert.deepEqual(svc.readTimes('shop-a'), { times: ['08:00', '17:00'], source: 'default' });
  svc.writeTimes('shop-a', ['18:30', '06:15']);
  const doc = JSON.parse(fs.readFileSync(settingsOf('shop-a'), 'utf8'));
  assert.deepEqual(doc, { keepMe: 42, dailySummaryTimes: ['06:15', '18:30'] });
  assert.deepEqual(svc.readTimes('shop-a'), { times: ['06:15', '18:30'], source: 'file' });
  assert.equal(fs.existsSync(`${settingsOf('shop-a')}.tmp`), false);
});

test('writeTimes: ค่าไม่ผ่าน validate → 400 และไม่แตะไฟล์', () => {
  svc.writeTimes('shop-b', ['09:00']);
  const before = fs.readFileSync(settingsOf('shop-b'), 'utf8');
  assert.throws(() => svc.writeTimes('shop-b', ['25:00']), (e) => e.statusCode === 400);
  assert.throws(() => svc.writeTimes('shop-b', []), (e) => e.statusCode === 400);
  assert.equal(fs.readFileSync(settingsOf('shop-b'), 'utf8'), before);
});

test('writeTimes: settings.json พัง → 409 ไม่เขียนทับ', () => {
  fs.mkdirSync(botDir('shop-c'), { recursive: true });
  fs.writeFileSync(settingsOf('shop-c'), '{broken');
  assert.throws(() => svc.writeTimes('shop-c', ['09:00']), (e) => e.statusCode === 409);
  assert.equal(fs.readFileSync(settingsOf('shop-c'), 'utf8'), '{broken');
});

test('ชื่อ bot ที่เป็น path traversal ถูกปฏิเสธ', () => {
  for (const bad of ['../x', '..', 'a/b', 'A_B', '']) {
    assert.throws(() => svc.settingsPath(bad), (e) => e.statusCode === 400, bad);
  }
});

// ── route: ต้อง login (session) + proxy reload ไปที่ bot ──────────────────────
test('route /api/bots/:name/daily-summary', async (t) => {
  const calls = [];
  dockerService.callBot = async (name, method, p) => {
    calls.push([name, method, p]);
    if (method === 'POST') return { reachable: true, status: 200, data: { ok: true, times: ['07:30', '20:00'], nextRun: null } };
    return { reachable: true, status: 200, data: { ok: true, times: ['08:00', '17:00'], nextRun: '2026-10-03T01:00:00.000Z' } };
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', apiRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${guard.SESSION_COOKIE}=${guard.createSession()}`;
  const req = (method, p, body, withCookie = true) => fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(withCookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  // ไม่ login → 401 ทั้ง GET และ PUT และไม่เขียนไฟล์
  assert.equal((await req('GET', '/api/bots/shop-d/daily-summary', null, false)).status, 401);
  assert.equal((await req('PUT', '/api/bots/shop-d/daily-summary', { times: ['07:00'] }, false)).status, 401);
  assert.equal(fs.existsSync(settingsOf('shop-d')), false);
  assert.equal(calls.length, 0);

  // ค่าไม่ผ่าน validate → 400 ข้อความชัดเจน ไม่ crash ไม่เรียก bot
  let r = await req('PUT', '/api/bots/shop-d/daily-summary', { times: ['07:00', '07:00'] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ซ้ำ/);
  r = await req('PUT', '/api/bots/shop-d/daily-summary', { times: [] });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/bots/shop-d/daily-summary', {});
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);

  // ชื่อ bot ผิด
  assert.equal((await req('PUT', '/api/bots/..%2Fx/daily-summary', { times: ['07:00'] })).status, 400);

  // สำเร็จ → เขียนไฟล์ แล้วสั่ง bot reload (POST) และรายงาน applied
  r = await req('PUT', '/api/bots/shop-d/daily-summary', { times: ['20:00', '07:30'] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.times, ['07:30', '20:00']);
  assert.equal(body.applied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsOf('shop-d'), 'utf8')).dailySummaryTimes, ['07:30', '20:00']);
  assert.deepEqual(calls.at(-1), ['shop-d', 'POST', '/api/daily-summary/reload']);

  // bot ไม่ทำงาน/image เก่า → บันทึกสำเร็จแต่ applied=false พร้อมคำอธิบาย
  dockerService.callBot = async () => ({ reachable: false, reason: 'not-running' });
  body.note = (await (await req('PUT', '/api/bots/shop-d/daily-summary', { times: ['09:00'] })).json());
  assert.equal(body.note.applied, false);
  assert.match(body.note.note, /ไม่ได้ทำงานอยู่/);
  dockerService.callBot = async () => ({ reachable: true, status: 404, data: null });
  r = await (await req('PUT', '/api/bots/shop-d/daily-summary', { times: ['10:00'] })).json();
  assert.equal(r.applied, false);
  assert.match(r.note, /image เก่า/);

  // GET คืนค่าที่บันทึก + สถานะที่ bot ใช้จริง
  dockerService.callBot = async () => ({ reachable: true, status: 200, data: { ok: true, times: ['10:00'], nextRun: null } });
  const g = await (await req('GET', '/api/bots/shop-d/daily-summary')).json();
  assert.deepEqual(g.times, ['10:00']);
  assert.equal(g.live.supported, true);
});
