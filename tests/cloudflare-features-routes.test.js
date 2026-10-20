// GET /api/features และข้อมูล Cloudflare ที่แนบกับ GET /api/bots (routes/api.js)
// flag ปิดและไม่มี state = คำตอบของ /bots เหมือนเดิมทุกไบต์ — dockerService.listBots ถูกแทนด้วยตัวจำลอง (ไม่แตะ Docker/Cloudflare)
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cffeat-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const express = require('express');
const cookieParser = require('cookie-parser');
const guard = require('../middleware/guard');
const statsDb = require('../services/stats-db');
const logger = require('../services/logger');
const realState = require('../services/cloudflare-state');
const dockerService = require('../services/docker');
const { createAutoTunnelService } = require('../services/cloudflare-auto');
const apiRoutes = require('../routes/api');
const { ACCT, ZONE, TID, REC, SETTINGS, makeFakes } = require('./helpers/cloudflare-fakes');

statsDb.initDb();
test.after(() => { statsDb.closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

let server;
let base;
let cookie;
let bots;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', apiRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `${guard.SESSION_COOKIE}=${guard.createSession()}`;
  dockerService.listBots = async () => JSON.parse(JSON.stringify(bots));
});
test.after(() => server.close());
test.beforeEach(() => {
  bots = [
    { id: 'a1', name: 'netguard-shop', state: 'running', port: 3101, tunnel: { exists: true }, meta: {} },
    { id: 'b2', name: 'netguard-plain', state: 'running', port: 3102, tunnel: { exists: false }, meta: {} },
  ];
  fs.rmSync(process.env.BOTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(process.env.BOTS_ROOT, 'shop'), { recursive: true });
  fs.mkdirSync(path.join(process.env.BOTS_ROOT, 'plain'), { recursive: true });
});
test.afterEach(() => dockerService.setAutoTunnelServiceForTests(null));

const get = (p, withCookie = true) => fetch(base + p, { headers: withCookie ? { Cookie: cookie } : {} });
const install = (settings) => dockerService.setAutoTunnelServiceForTests(createAutoTunnelService({
  settings, client: makeFakes().client, state: realState, ops: makeFakes().ops, logger: makeFakes().logger,
}));
const seedState = (name = 'shop', over = {}) => realState.writeState(name, {
  accountId: ACCT, zoneId: ZONE, tunnelId: TID, hostname: `${name}.example.com`, dnsRecordId: REC, step: 'complete', ...over,
});

test('GET /features: ต้อง login', async () => {
  assert.equal((await get('/api/features', false)).status, 401);
});

test('GET /features: flag ปิด → {cloudflareAutoTunnel:false} เท่านั้น', async () => {
  install({ ...SETTINGS, enabled: false });
  const res = await get('/api/features');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cloudflareAutoTunnel: false });
});

test('GET /features: flag เปิด → บอก zone name เท่านั้น ไม่มี account/zone ID หรือ token', async () => {
  install(SETTINGS);
  const body = await (await get('/api/features')).json();
  assert.deepEqual(body, { cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(ACCT) && !raw.includes(ZONE));
});

test('GET /features: ค่าเริ่มต้นจาก env จริงของเทสต์ = ปิด', async () => {
  dockerService.setAutoTunnelServiceForTests(null);
  assert.deepEqual(await (await get('/api/features')).json(), { cloudflareAutoTunnel: false });
});

test('GET /bots: ไม่มี state เลย → คำตอบเหมือนที่ listBots คืนทุกประการ (ไม่มี key cloudflare)', async () => {
  const body = await (await get('/api/bots')).json();
  assert.deepEqual(body, bots);
  assert.ok(body.every((b) => !('cloudflare' in b)));
});

test('GET /bots: บอทที่มี state ได้ cloudflare:{hostname, step} (ไม่มี tunnel/account/zone/record ID); บอทอื่นไม่เปลี่ยน — ได้ทั้งตอน flag เปิดและปิด', async () => {
  seedState('shop', { step: 'complete' });
  for (const settings of [SETTINGS, { ...SETTINGS, enabled: false }]) {
    install(settings);
    const body = await (await get('/api/bots')).json();
    assert.deepEqual(body[0].cloudflare, { hostname: 'shop.example.com', step: 'complete' });
    assert.ok(!JSON.stringify(body).includes(TID) && !JSON.stringify(body).includes(REC));
    assert.ok(!('cloudflare' in body[1]));
    assert.deepEqual({ ...body[0], cloudflare: undefined }, { ...bots[0], cloudflare: undefined });
  }
});

test('GET /bots: state ของบอทใดเสีย → ยังคืนรายการบอทครบ (ไม่ทำให้หน้าหลักพัง) และ log เตือน', async () => {
  fs.writeFileSync(path.join(process.env.BOTS_ROOT, 'shop', 'cloudflare.json'), '{broken');
  const lines = [];
  const orig = logger.warn;
  logger.warn = (...a) => lines.push(a.join(' '));
  try {
    const res = await get('/api/bots');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), bots);
  } finally {
    logger.warn = orig;
  }
  assert.ok(lines.some((l) => /cloudflare/i.test(l)));
});

test('GET /bots: error ของ listBots ยังส่งต่อเป็น 500 ตามเดิม', async () => {
  const orig = dockerService.listBots;
  dockerService.listBots = async () => { throw new Error('docker down'); };
  try {
    assert.equal((await get('/api/bots')).status, 500);
  } finally {
    dockerService.listBots = orig;
  }
});

test('GET /bots: บอทที่ชื่อไม่ใช่รูปแบบบอทของ Manager (สร้างนอก Manager) ไม่ถูกอ่าน state และไม่ทำให้เกิด warning', async () => {
  bots.push({ id: 'c3', name: 'netguard-Odd_Name', state: 'running', port: 3103, tunnel: { exists: false }, meta: {} });
  const lines = [];
  const orig = logger.warn;
  logger.warn = (...a) => lines.push(a.join(' '));
  try {
    const body = await (await get('/api/bots')).json();
    assert.deepEqual(body, bots);
  } finally {
    logger.warn = orig;
  }
  assert.deepEqual(lines, []);
});
