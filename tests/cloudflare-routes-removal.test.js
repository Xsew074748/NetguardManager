// route ฝั่งลบบอท/ลองสร้าง tunnel ใหม่/รายการค้าง: DELETE /bots/:id, POST /bots/:name/tunnel/auto, GET|POST /cloudflare/orphans...
// dockerService ถูกแทนด้วยตัวจำลอง (ไม่แตะ Docker/Cloudflare) — รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfroutes2-'));
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

const TID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'tunneltoken_ROUTE_SECRET_0123456789abcdefghij';

let server;
let base;
let cookie;
const seen = {};
let impl = {};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', apiRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `${guard.SESSION_COOKIE}=${guard.createSession()}`;
  for (const fn of ['removeBot', 'retryAutoTunnel', 'listCloudflareOrphans', 'cleanupCloudflareOrphan']) {
    dockerService[fn] = async (...args) => { (seen[fn] = seen[fn] || []).push(args); return impl[fn](...args); };
  }
});
test.after(() => server.close());
test.beforeEach(() => {
  for (const k of Object.keys(seen)) delete seen[k];
  impl = {
    removeBot: async () => undefined,
    retryAutoTunnel: async (name, hostname) => ({ status: 'ok', hostname }),
    listCloudflareOrphans: () => [],
    cleanupCloudflareOrphan: async () => ({ status: 'cleaned', failed: [] }),
  };
});

const call = (method, p, body, withCookie = true) => fetch(base + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(withCookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const auditRows = async (action) => (await (await fetch(`${base}/api/audit?action=${action}&limit=50`, { headers: { Cookie: cookie } })).json()).rows;

// ── DELETE /bots/:id ─────────────────────────────────────────────────────────
test('DELETE /bots/:id แบบเดิม: ส่ง deleteFiles เป็น boolean, deleteCloudflare=undefined; ตอบ {ok:true} เท่านั้นเมื่อ removeBot ไม่คืนอะไร', async () => {
  const res = await call('DELETE', '/api/bots/abc123?deleteFiles=true');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(seen.removeBot[0], ['abc123', { deleteFiles: true, deleteCloudflare: undefined }]);
  await call('DELETE', '/api/bots/abc123');
  assert.deepEqual(seen.removeBot[1], ['abc123', { deleteFiles: false, deleteCloudflare: undefined }]);
});

test('DELETE /bots/:id: deleteCloudflare รับเฉพาะ "true"/"false" — ค่าอื่นเป็น undefined (ไม่ลบ Cloudflare)', async () => {
  for (const [q, expected] of [['true', true], ['false', false], ['1', undefined], ['yes', undefined], ['TRUE', undefined], ['', undefined]]) {
    seen.removeBot = [];
    await call('DELETE', `/api/bots/abc123?deleteCloudflare=${q}`);
    assert.equal(seen.removeBot[0][1].deleteCloudflare, expected, q);
  }
});

test('DELETE /bots/:id: ผล cloudflare จาก removeBot ถูกรวมในคำตอบ; ตัวเลข/ค่าที่ไม่ใช่ object ไม่ถูกรวม (เทสต์เดิมที่ mock คืนจำนวน)', async () => {
  impl.removeBot = async () => ({ cloudflare: { status: 'partial', rollback: { ok: false, failed: ['tunnel'], orphaned: true } } });
  assert.deepEqual(await (await call('DELETE', '/api/bots/abc123?deleteCloudflare=true')).json(), {
    ok: true, cloudflare: { status: 'partial', rollback: { ok: false, failed: ['tunnel'], orphaned: true } },
  });
  impl.removeBot = async () => 3;
  assert.deepEqual(await (await call('DELETE', '/api/bots/abc123')).json(), { ok: true });
});

test('DELETE /bots/:id: error 409 (flag ปิด/ล็อกชน) ส่งต่อรหัสและข้อความ', async () => {
  impl.removeBot = async () => { throw Object.assign(new Error('Cannot delete Cloudflare resources'), { statusCode: 409 }); };
  const res = await call('DELETE', '/api/bots/abc123?deleteCloudflare=true');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Cannot delete Cloudflare/);
});

test('audit ของ DELETE /bots/:id: บันทึก deleteCloudflare และสถานะ cloudflare', async () => {
  impl.removeBot = async () => ({ cloudflare: { status: 'removed', rollback: { ok: true, failed: [], orphaned: false } } });
  await call('DELETE', '/api/bots/auditdel1?deleteFiles=true&deleteCloudflare=true');
  const row = (await auditRows('bot.remove')).find((r) => r.target === 'auditdel1');
  assert.equal(row.detail.deleteFiles, true);
  assert.equal(row.detail.deleteCloudflare, true);
  assert.equal(row.detail.cloudflare, 'removed');
});

// ── POST /bots/:name/tunnel/auto ─────────────────────────────────────────────
test('POST /bots/:name/tunnel/auto สำเร็จ → 201 {ok, tunnel}', async () => {
  const res = await call('POST', '/api/bots/shop/tunnel/auto', { hostname: 'shop.example.com' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, tunnel: { status: 'ok', hostname: 'shop.example.com' } });
  assert.deepEqual(seen.retryAutoTunnel[0], ['shop', 'shop.example.com']);
});

test('POST /bots/:name/tunnel/auto ล้มกลางทาง → 502 พร้อมรายละเอียดขั้น/rollback; ชื่อผิด/ไม่มี hostname → 400', async () => {
  impl.retryAutoTunnel = async (name, hostname) => ({ status: 'failed', step: 'create-dns', message: 'cloudflare createCname: HTTP 400', hostname, rollback: { ok: true, failed: [], orphaned: false } });
  const res = await call('POST', '/api/bots/shop/tunnel/auto', { hostname: 'shop.example.com' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /createCname/);
  assert.equal(body.tunnel.step, 'create-dns');
  assert.equal((await call('POST', '/api/bots/Bad%20Name/tunnel/auto', { hostname: 'x.example.com' })).status, 400);
  assert.equal((await call('POST', '/api/bots/shop/tunnel/auto', {})).status, 400);
  assert.equal((await call('POST', '/api/bots/shop/tunnel/auto', { hostname: 42 })).status, 400);
});

test('POST /bots/:name/tunnel/auto: error ของ service (409 hostname-in-use ฯลฯ) ส่งต่อ; audit บันทึกชื่อ action และสถานะ ไม่มี token', async () => {
  impl.retryAutoTunnel = async () => { throw Object.assign(new Error(`A DNS record already exists ${TOKEN}`), { statusCode: 409 }); };
  assert.equal((await call('POST', '/api/bots/auditauto/tunnel/auto', { hostname: 'auditauto.example.com' })).status, 409);
  impl.retryAutoTunnel = async (name, hostname) => ({ status: 'ok', hostname });
  await call('POST', '/api/bots/auditauto2/tunnel/auto', { hostname: 'auditauto2.example.com' });
  const rows = await auditRows('tunnel.auto-create');
  const ok = rows.find((r) => r.target === 'auditauto2');
  assert.equal(ok.result, 'ok');
  assert.equal(ok.detail.tunnel, 'ok');
  assert.ok(rows.some((r) => r.target === 'auditauto' && r.result === 'fail'));
  assert.ok(!JSON.stringify(rows).includes(TOKEN));
});

// ── รายการค้าง ──────────────────────────────────────────────────────────────
test('GET /cloudflare/orphans: คืนรายการ; error 500 ส่งต่อ', async () => {
  impl.listCloudflareOrphans = () => [{ botName: 'shop', hostname: 'shop.example.com', tunnelId: TID, leftovers: ['tunnel'] }];
  const res = await call('GET', '/api/cloudflare/orphans');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).orphans[0].tunnelId, TID);
  impl.listCloudflareOrphans = () => { throw new Error('cf-orphans.json is corrupt'); };
  assert.equal((await call('GET', '/api/cloudflare/orphans')).status, 500);
});

test('POST /cloudflare/orphans/:tunnelId/cleanup: tunnelId ต้องเป็น UUID (400); สำเร็จส่งผลตรงๆ; ส่ง tunnelId ให้ service; audit action ชื่อ cloudflare.orphan-cleanup', async () => {
  assert.equal((await call('POST', '/api/cloudflare/orphans/not-a-uuid/cleanup')).status, 400);
  assert.equal((await call('POST', '/api/cloudflare/orphans/..%2Fx/cleanup')).status, 400);
  assert.equal(seen.cleanupCloudflareOrphan, undefined);
  impl.cleanupCloudflareOrphan = async () => ({ status: 'partial', failed: ['tunnel'] });
  const res = await call('POST', `/api/cloudflare/orphans/${TID}/cleanup`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'partial', failed: ['tunnel'] });
  assert.deepEqual(seen.cleanupCloudflareOrphan[0], [TID]);
  const rows = await auditRows('cloudflare.orphan-cleanup');
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].detail.cleanup, 'partial');
  impl.cleanupCloudflareOrphan = async () => { throw Object.assign(new Error('No such leftover entry'), { statusCode: 404 }); };
  assert.equal((await call('POST', `/api/cloudflare/orphans/${TID}/cleanup`)).status, 404);
});

test('ทุก route ใหม่ต้อง login (401 เมื่อไม่มี session)', async () => {
  for (const [m, p, b] of [
    ['DELETE', '/api/bots/abc?deleteCloudflare=true'],
    ['POST', '/api/bots/shop/tunnel/auto', { hostname: 'shop.example.com' }],
    ['GET', '/api/cloudflare/orphans'],
    ['POST', `/api/cloudflare/orphans/${TID}/cleanup`],
  ]) {
    assert.equal((await call(m, p, b, false)).status, 401, `${m} ${p}`);
  }
  assert.equal(seen.removeBot, undefined);
});
