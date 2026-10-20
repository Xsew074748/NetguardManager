// route ของ auto-tunnel ใน routes/api.js: POST /bots รับ autoTunnel/hostname แล้วส่งต่อ, audit ไม่มี token, ผลลัพธ์ไม่เปลี่ยนเมื่อ flag ปิด
// dockerService.createBot ถูกแทนด้วยตัวจำลอง (ไม่แตะ Docker/Cloudflare) — รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfroutes-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const express = require('express');
const cookieParser = require('cookie-parser');
const guard = require('../middleware/guard');
const statsDb = require('../services/stats-db');
const dockerService = require('../services/docker');
const apiRoutes = require('../routes/api');

statsDb.initDb();
test.after(() => { statsDb.closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

const TOKEN = 'manual_tunnel_token_SECRET_0123456789abcdef';

let server;
let base;
let cookie;
const seen = [];
let createImpl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', apiRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `${guard.SESSION_COOKIE}=${guard.createSession()}`;
  dockerService.createBot = async (args) => { seen.push(args); return createImpl(args); };
});
test.after(() => server.close());
test.beforeEach(() => {
  seen.length = 0;
  createImpl = async (a) => ({ id: 'cid', name: `netguard-${a.name}`, port: a.port });
});

const post = (body) => fetch(`${base}/api/bots`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
const auditRows = async (action) => (await (await fetch(`${base}/api/audit?action=${action}&limit=50`, { headers: { Cookie: cookie } })).json()).rows;

test('POST /bots: autoTunnel=true + hostname ถูกส่งต่อให้ createBot; ผลลัพธ์ (รวม tunnel) ถูกส่งกลับตามเดิม', async () => {
  createImpl = async (a) => ({ id: 'cid', name: `netguard-${a.name}`, port: a.port, tunnel: { status: 'ok', hostname: a.hostname } });
  const res = await post({ name: 'shop', port: 40001, autoTunnel: true, hostname: 'shop.example.com', companyName: 'ACME' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: 'cid', name: 'netguard-shop', port: 40001, tunnel: { status: 'ok', hostname: 'shop.example.com' } });
  assert.equal(seen[0].autoTunnel, true);
  assert.equal(seen[0].hostname, 'shop.example.com');
  assert.equal(seen[0].companyName, 'ACME');
});

test('POST /bots: autoTunnel รับเฉพาะ true / "true" — ค่าอื่น (1, "yes", {}, "false") = ไม่ใช่ auto', async () => {
  for (const [value, expected] of [[true, true], ['true', true], [false, false], ['false', false], [1, false], ['yes', false], [{}, false], [null, false]]) {
    seen.length = 0;
    await post({ name: 'shop', port: 40001, autoTunnel: value, hostname: 'shop.example.com' });
    assert.equal(seen[0].autoTunnel, expected, JSON.stringify(value));
  }
});

test('POST /bots แบบเดิม (ไม่มี autoTunnel): ผลลัพธ์และอาร์กิวเมนต์เหมือนเดิม; tunnelToken เองยังส่งต่อ', async () => {
  const res = await post({ name: 'plain', port: 40002, tunnelToken: TOKEN });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: 'cid', name: 'netguard-plain', port: 40002 });
  assert.equal(seen[0].autoTunnel, false);
  assert.equal(seen[0].tunnelToken, TOKEN);
});

test('POST /bots: error จาก createBot (เช่น 409 hostname-in-use) ส่งต่อรหัสสถานะและข้อความ', async () => {
  createImpl = async () => { throw Object.assign(new Error('A DNS record already exists'), { statusCode: 409 }); };
  const res = await post({ name: 'shop', port: 40001, autoTunnel: true, hostname: 'shop.example.com' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /DNS record already exists/);
});

test('audit ของ POST /bots: บันทึกว่าเป็น auto + hostname + สถานะ tunnel แต่ไม่มี token (ทั้ง token มือและ token ที่ปนมากับข้อความ error)', async () => {
  createImpl = async (a) => ({ id: 'cid', name: `netguard-${a.name}`, port: a.port, tunnel: { status: 'failed', step: 'create-dns', hostname: a.hostname, message: 'x', rollback: { ok: true, failed: [], orphaned: false } } });
  await post({ name: 'auditone', port: 40003, autoTunnel: true, hostname: 'auditone.example.com' });
  createImpl = async () => { throw Object.assign(new Error(`failed with ${TOKEN}`), { statusCode: 500 }); };
  await post({ name: 'audittwo', port: 40004, tunnelToken: TOKEN });
  const rows = await auditRows('bot.create');
  const one = rows.find((r) => r.target === 'auditone');
  assert.equal(one.detail.autoTunnel, true);
  assert.equal(one.detail.tunnel, 'failed');
  assert.equal(one.detail.status, 201);
  const two = rows.find((r) => r.target === 'audittwo');
  assert.equal(two.detail.withTunnel, true);
  assert.equal(two.detail.autoTunnel, false);
  assert.ok(!JSON.stringify(rows).includes(TOKEN));
});
