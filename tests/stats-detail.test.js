// ข้อมูลละเอียด Omada/HikCentral: ตารางใน stats-db, rollup รายชั่วโมง, retention/prune, poller (ทน error),
// route /stats/series, และการระบุ image ต่อ bot ทดสอบ — ใช้ node:test ในตัว ไม่เพิ่ม dependency
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-detail-'));
process.env.BOTS_ROOT = root;
process.env.DB_PATH = path.join(root, 'stats.test.db');

const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('../config');
const guard = require('../middleware/guard');
const dockerService = require('../services/docker');
const statsDb = require('../services/stats-db');
const poller = require('../services/poller');
const apiRoutes = require('../routes/api');

statsDb.initDb();
test.after(() => statsDb.closeDb());

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;

function detail({ clients = 10, traffic = { apTx: 100, apRx: 1000, swTx: 0, swRx: 0 }, top = [], events = null, cams = [], windowSec = 300 } = {}) {
  const d = {
    ok: true, windowSec,
    omada: {
      clients: clients === null ? null : { total: clients, wireless: clients - 2, wired: 2, num2g: 3, num5g: clients - 5, num6g: 0, guest: 1 },
      overview: { totalPorts: 24, availablePorts: 20, powerConsumption: 38 },
      traffic, topClients: top,
    },
  };
  if (events) d.hikcentral = { events, topCameras: cams, windowSec };
  return d;
}

// ── stats-db ────────────────────────────────────────────────────────────────
test('insertDetail: เขียน omada + hik + top lists และรายงานว่าเขียน section ไหน', () => {
  const r = statsDb.insertDetail('b1', detail({
    top: [{ mac: 'A', name: 'a', ap: 'AP1', down: 10, up: 5 }],
    events: { total: 3, motion: 2, videoLoss: 1, tamper: 0, other: 0, truncated: false },
    cams: [{ id: 'C1', name: 'Cam1', count: 3 }],
  }), NOW - 600);
  assert.deepEqual(r, { omada: true, omadaTraffic: true, hik: true });
  const o = statsDb.getOmadaSeries('b1', '24h').points;
  assert.equal(o.length, 1);
  assert.equal(o[0].clients, 10);
  assert.equal(o[0].ap_rx, 1000);
  assert.equal(o[0].window_sec, 300);
  assert.equal(o[0].power, 38);
  const h = statsDb.getHikSeries('b1', '24h').points;
  assert.equal(h[0].total, 3);
  assert.equal(h[0].video_loss, 1);
  assert.equal(statsDb.getTopCameras('b1', '24h')[0].count, 3);
});

test('insertDetail: section ที่ null ไม่ถูกเขียนเป็น 0 / ไม่เขียนแถว', () => {
  // traffic ดึงไม่ได้ → window_sec NULL (ไม่นับว่าครอบคลุม) แต่ client ยังเก็บ
  let r = statsDb.insertDetail('b2', detail({ traffic: null }), NOW - 300);
  assert.deepEqual(r, { omada: true, omadaTraffic: false, hik: false });
  const p = statsDb.getOmadaSeries('b2', '24h').points[0];
  assert.equal(p.window_sec, null);
  assert.equal(p.ap_rx, null);
  assert.equal(p.clients, 10);
  // field traffic ชื่อไม่รู้จัก (tx/rx = null) → ก็ไม่ถือว่าครอบคลุม
  r = statsDb.insertDetail('b2', detail({ traffic: { apTx: null, apRx: null, swTx: null, swRx: null } }), NOW - 200);
  assert.equal(r.omadaTraffic, false);
  // HikCentral events null (timeout) → ไม่มีแถว hik
  const d = detail(); d.hikcentral = { events: null, topCameras: [], eventsUnavailable: 'fetch-failed' };
  r = statsDb.insertDetail('b2', d, NOW - 100);
  assert.equal(r.hik, false);
  assert.equal(statsDb.getHikSeries('b2', '24h').points.length, 0);
  // ไม่มีอะไรเลย → ไม่เขียน
  assert.deepEqual(statsDb.insertDetail('b2', { ok: true }, NOW), { omada: false, omadaTraffic: false, hik: false });
});

test('ค่าที่ไม่ใช่ตัวเลข/ยาวผิดปกติถูกกรอง (ไม่ crash, ไม่เก็บ string ยาว)', () => {
  const long = 'x'.repeat(5000);
  statsDb.insertDetail('b3', detail({ clients: 'abc', top: [{ mac: long, name: long, ap: long, down: 'NaN', up: 1 }] }), NOW - 50);
  const p = statsDb.getOmadaSeries('b3', '24h').points[0];
  assert.equal(p.clients, null);
  const top = statsDb.getTopClients('b3', '24h');
  assert.deepEqual(top, []); // down=NaN→0, up=1 ครั้งเดียว ไม่มีส่วนต่าง
});

test('rollup รายชั่วโมง: 7d/30d รวมจาก hourly (sum traffic/event, avg client, max client)', () => {
  const base = Math.floor(NOW / HOUR) * HOUR - 3 * HOUR; // ต้นชั่วโมงที่ผ่านไปแล้ว
  for (let i = 0; i < 4; i++) {
    statsDb.insertDetail('b4', detail({
      clients: 10 + i * 10, traffic: { apTx: 10, apRx: 100, swTx: 1, swRx: 2 },
      events: { total: 2, motion: 1, videoLoss: 1, tamper: 0, other: 0 },
    }), base + i * 300);
  }
  const s7 = statsDb.getOmadaSeries('b4', '7d').points;
  assert.equal(s7.length, 1);
  assert.equal(s7[0].t, base);
  assert.equal(s7[0].clients, 25);       // avg(10,20,30,40)
  assert.equal(s7[0].clients_max, 40);
  assert.equal(s7[0].ap_rx, 400);        // sum
  assert.equal(s7[0].window_sec, 1200);  // sum ของช่วงที่ครอบคลุม
  const h7 = statsDb.getHikSeries('b4', '7d').points;
  assert.equal(h7[0].total, 8);
  assert.equal(h7[0].video_loss, 4);
  const s30 = statsDb.getOmadaSeries('b4', '30d');
  assert.equal(s30.bucketSec, 6 * HOUR);
  assert.equal(s30.points.reduce((a, p) => a + p.ap_rx, 0), 400);
});

test('bucket 7d = รายชั่วโมง, 30d = ทีละ 6 ชั่วโมง (หารจำนวนเต็ม — ไม่ใช่จุดเท่าข้อมูลดิบ)', () => {
  const six = 6 * HOUR;
  const start = Math.floor(NOW / six) * six - 2 * six; // ต้น bucket 6 ชม. ที่ผ่านไปแล้ว
  for (let h = 0; h < 6; h++) {
    for (let k = 0; k < 2; k++) {
      statsDb.insertDetail('b9', detail({ clients: 10, traffic: { apTx: 1, apRx: 2, swTx: 0, swRx: 0 }, events: { total: 1, motion: 1, videoLoss: 0, tamper: 0, other: 0 } }), start + h * HOUR + k * 300);
      statsDb.insertSample('b9', { ts: start + h * HOUR + k * 300, state: 'up', problems: { total: 2 }, devices: { hosts: { total: 4, up: 4 } } });
    }
  }
  const o7 = statsDb.getOmadaSeries('b9', '7d').points;
  const o30 = statsDb.getOmadaSeries('b9', '30d').points;
  assert.equal(o7.length, 6);
  assert.equal(o30.length, 1);
  assert.equal(o30[0].t, start);
  assert.equal(o30[0].ap_rx, 24); // 12 sample * 2
  assert.equal(statsDb.getHikSeries('b9', '30d').points.length, 1);
  assert.equal(statsDb.getHikSeries('b9', '30d').points[0].total, 12);
  assert.equal(statsDb.getBaseSeries('b9', '7d').points.length, 6);
  const b30 = statsDb.getBaseSeries('b9', '30d').points;
  assert.equal(b30.length, 1);
  assert.equal(b30[0].problems_total, 2);
  assert.equal(statsDb.getBaseSeries('b9', '24h').points.length, 12);
});

test('rollup เรียกซ้ำได้ (idempotent) และอัปเดตชั่วโมงปัจจุบัน', () => {
  const before = JSON.stringify(statsDb.getOmadaSeries('b4', '7d').points);
  statsDb.rollupDetailHourly(NOW - 10 * DAY);
  statsDb.rollupDetailHourly(NOW - 10 * DAY);
  assert.equal(JSON.stringify(statsDb.getOmadaSeries('b4', '7d').points), before);
});

test('getTopClients: รวมเฉพาะส่วนต่างของยอดสะสม, session รีเซ็ตไม่ติดลบ, เรียงมาก→น้อย', () => {
  const t0 = NOW - 2000;
  const at = (i, rows) => statsDb.insertDetail('b5', detail({ top: rows }), t0 + i * 300);
  at(0, [{ mac: 'A', name: 'alice', down: 1000, up: 100 }, { mac: 'B', name: 'bob', down: 50, up: 0 }]);
  at(1, [{ mac: 'A', name: 'alice', down: 3000, up: 300 }, { mac: 'B', name: 'bob', down: 60, up: 0 }]);
  at(2, [{ mac: 'A', name: 'alice', down: 200, up: 20 }, { mac: 'B', name: 'bob', down: 70, up: 5 }, { mac: 'C', name: 'carol', down: 9, up: 9 }]);
  const top = statsDb.getTopClients('b5', '24h');
  // alice: (3000-1000)+(200 รีเซ็ต) = 2200 down, (300-100)+20 = 220 up
  assert.deepEqual(top.map((c) => c.name), ['alice', 'bob']); // carol โผล่ครั้งเดียว ไม่มีส่วนต่าง → ไม่แสดง
  assert.equal(top[0].down, 2200);
  assert.equal(top[0].up, 220);
  assert.equal(top[1].total, 25); // bob: 10 + (10+5)
  assert.equal(statsDb.getTopClients('b5', '24h', 1).length, 1);
});

test('retention: prune ลบดิบเก่ากว่า 14 วัน แต่ hourly ยังอยู่ และข้อมูลใหม่ไม่หาย', () => {
  const old = NOW - 20 * DAY;
  statsDb.insertDetail('b6', detail({ top: [{ mac: 'A', name: 'a', down: 1, up: 1 }], events: { total: 1, motion: 1, videoLoss: 0, tamper: 0, other: 0 }, cams: [{ id: 'C', name: 'c', count: 1 }] }), old);
  statsDb.insertDetail('b6', detail(), NOW - 600);
  const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });
  const n = (tbl) => db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE bot_name = 'b6'`).get().n;
  assert.equal(n('omada_samples'), 2);
  assert.equal(n('omada_hourly'), 2);
  const removed = statsDb.pruneDetail();
  assert.ok(removed >= 3); // omada_samples + top_clients + hik_samples + top_cameras ของแถวเก่า
  assert.equal(n('omada_samples'), 1);
  assert.equal(n('omada_top_clients'), 0);
  assert.equal(n('hik_samples'), 0);
  assert.equal(n('hik_top_cameras'), 0);
  assert.equal(n('omada_hourly'), 2, 'hourly ของเก่ายังเก็บ (retention 90 วัน)');
  // ลำดับสำคัญ: ก่อนลบดิบต้องสรุปรายชั่วโมงให้ครบ
  const h30 = statsDb.getOmadaSeries('b6', '30d').points;
  assert.ok(h30.length >= 1);
  db.close();
});

test('retention: hourly เก่ากว่า 90 วันถูกลบ', () => {
  const ancient = NOW - 100 * DAY;
  statsDb.insertDetail('b7', detail(), ancient);
  const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });
  const hourly = () => db.prepare(`SELECT COUNT(*) AS n FROM omada_hourly WHERE bot_name='b7'`).get().n;
  assert.equal(hourly(), 1);
  statsDb.pruneDetail();
  assert.equal(hourly(), 0);
  db.close();
});

test('getLastDetailTs / hasDetailData', () => {
  assert.equal(statsDb.getLastDetailTs('nobody').omadaTraffic, null);
  assert.deepEqual(statsDb.hasDetailData('nobody'), { omada: false, hik: false });
  const l = statsDb.getLastDetailTs('b1');
  assert.equal(l.omadaTraffic, NOW - 600);
  assert.equal(l.hikEvents, NOW - 600);
  assert.deepEqual(statsDb.hasDetailData('b1'), { omada: true, hik: true });
  // b2: สองรอบแรก traffic ใช้ไม่ได้ (ไม่นับ) รอบที่สาม (NOW-100) traffic ปกติ; ไม่เคยมี hik events เลย
  assert.equal(statsDb.getLastDetailTs('b2').omadaTraffic, NOW - 100);
  assert.equal(statsDb.getLastDetailTs('b2').hikEvents, null);
  // b3: traffic ปกติเสมอแต่ไม่เคยมี hik
  assert.equal(statsDb.getLastDetailTs('b3').hikEvents, null);
});

test('getLatest: ค่าดิบล่าสุด ไม่ใช่ค่าเฉลี่ยของ bucket (การ์ด "ตอนนี้")', () => {
  assert.deepEqual(statsDb.getLatest('nobody'), { base: null, omada: null });
  const t = NOW - 700;
  statsDb.insertDetail('b10', detail({ clients: 10 }), t);
  statsDb.insertDetail('b10', detail({ clients: 90 }), t + 300);
  statsDb.insertSample('b10', { ts: t + 300, state: 'up', problems: { total: 7 }, devices: { hosts: { total: 5, up: 4 } } });
  statsDb.insertSample('b10', { ts: t + 600, state: 'down' }); // down ไม่ถือเป็น "ล่าสุดที่รู้ค่า"
  const l = statsDb.getLatest('b10');
  assert.equal(l.omada.clients, 90);
  assert.equal(l.base.problems_total, 7);
  assert.equal(l.base.hosts_up, 4);
  // ขณะที่ค่าใน series 7d เป็นค่าเฉลี่ยของชั่วโมง
  const avg = statsDb.getOmadaSeries('b10', '7d').points.at(-1).clients;
  assert.ok(avg < 90 && avg > 10);
});

test('getBaseSeries: 24h = ดิบ, 7d/30d = เฉลี่ยต่อ bucket เฉพาะ sample ที่ up', () => {
  const t = NOW - 600;
  statsDb.insertSample('b8', { ts: t, state: 'up', problems: { total: 4, disaster: 1, high: 1, average: 1, warning: 1 }, devices: { hosts: { total: 10, up: 9 }, cameras: { total: 5, up: 5 } } });
  statsDb.insertSample('b8', { ts: t + 300, state: 'down' });
  const d24 = statsDb.getBaseSeries('b8', '24h');
  assert.equal(d24.points.length, 2);
  const d7 = statsDb.getBaseSeries('b8', '7d');
  assert.equal(d7.points.length, 1);
  assert.equal(d7.points[0].problems_total, 4);
  assert.equal(d7.points[0].hosts_up, 9);
  assert.equal(statsDb.resolveRange('bogus').key, '24h');
});

// ── poller.pollDetail ───────────────────────────────────────────────────────
test('pollDetail: bot ที่ไม่มี omada/hikcentral → ไม่ยิง /stats/detail', async () => {
  let called = 0;
  const r = await poller.pollDetail('pz-none', { monitors: ['zabbix'] }, { fetchDetail: async () => { called++; return {}; } });
  assert.equal(r, null);
  assert.equal(called, 0);
  assert.equal(poller.getDetailStatus('pz-none').status, 'not-applicable');
});

test('pollDetail: สำเร็จ → เขียน DB และเลื่อนต้นหน้าต่างเฉพาะฝั่งที่เขียนได้', async () => {
  const calls = [];
  let clock = NOW - 5000;
  const deps = { now: () => clock, fetchDetail: async (name, since, evSince) => { calls.push([since, evSince]); return deps.next; } };

  deps.next = detail({ events: { total: 1, motion: 1, videoLoss: 0, tamper: 0, other: 0 } });
  await poller.pollDetail('pz1', { monitors: ['omada', 'hikcentral'] }, deps);
  assert.deepEqual(calls[0], [null, null]); // รอบแรก ไม่มีประวัติ → ให้ bot ใช้หน้าต่างปริยาย
  const t1 = clock;

  // รอบสอง: HikCentral พัง (events null) แต่ Omada ปกติ
  clock += 300;
  deps.next = detail(); deps.next.hikcentral = { events: null, topCameras: [], eventsUnavailable: 'fetch-failed' }; deps.next.partial = true; deps.next.failed = ['hikcentral'];
  await poller.pollDetail('pz1', { monitors: ['omada', 'hikcentral'] }, deps);
  assert.deepEqual(calls[1], [t1, t1]);
  assert.equal(poller.getDetailStatus('pz1').status, 'partial');
  const t2 = clock;

  // รอบสาม: ต้นหน้าต่าง traffic เลื่อนไปที่รอบสอง แต่ event ยังย้อนไปรอบแรก (ดึงช่วงที่ขาดให้)
  clock += 300;
  deps.next = detail({ events: { total: 0, motion: 0, videoLoss: 0, tamper: 0, other: 0 } });
  await poller.pollDetail('pz1', { monitors: ['omada', 'hikcentral'] }, deps);
  assert.deepEqual(calls[2], [t2, t1]);
  assert.equal(poller.getDetailStatus('pz1').status, 'ok');
});

test('pollDetail: fetch error / response ไม่ ok → ไม่ throw, ไม่เขียน, ไม่เลื่อนหน้าต่าง', async () => {
  const calls = [];
  const clock = NOW - 4000;
  const deps = { now: () => clock, fetchDetail: async (n, s, e) => { calls.push([s, e]); return deps.next(); } };
  deps.next = () => detail();
  await poller.pollDetail('pz2', { monitors: ['omada'] }, deps);
  const rows = () => statsDb.getOmadaSeries('pz2', '24h').points.length;
  assert.equal(rows(), 1);

  deps.next = () => { throw new Error('boom'); };
  assert.equal(await poller.pollDetail('pz2', { monitors: ['omada'] }, deps), null);
  assert.equal(poller.getDetailStatus('pz2').status, 'error');
  deps.next = () => ({ ok: false });
  assert.equal(await poller.pollDetail('pz2', { monitors: ['omada'] }, deps), null);
  assert.equal(rows(), 1);

  deps.next = () => detail();
  await poller.pollDetail('pz2', { monitors: ['omada'] }, deps);
  assert.deepEqual(calls[1], [clock, null]);
  assert.deepEqual(calls[2], [clock, null], 'พังสองรอบ ต้นหน้าต่างยังอยู่ที่รอบที่สำเร็จล่าสุด');
  assert.deepEqual(calls[3], [clock, null]);
});

test('pollDetail: bot image เก่า (404) → status unsupported ไม่ throw', async () => {
  const deps = { fetchDetail: async () => { const e = new Error('old'); e.code = 'unsupported'; throw e; } };
  assert.equal(await poller.pollDetail('pz3', { monitors: ['omada'] }, deps), null);
  assert.equal(poller.getDetailStatus('pz3').status, 'unsupported');
  assert.equal(await poller.pollDetail('pz3', { monitors: ['omada'] }, deps), null);
});

test('pollDetail: restart ของ manager → เริ่มต้นหน้าต่างจาก ts ล่าสุดใน DB', async () => {
  statsDb.insertDetail('pz4', detail({ events: { total: 1, motion: 1, videoLoss: 0, tamper: 0, other: 0 } }), NOW - 900);
  const seen = [];
  await poller.pollDetail('pz4', { monitors: ['omada', 'hikcentral'] }, { fetchDetail: async (n, s, e) => { seen.push([s, e]); return detail(); } });
  assert.deepEqual(seen[0], [NOW - 900, NOW - 900]);
});

// ── image ต่อ bot (เฉพาะ bot ทดสอบ) ─────────────────────────────────────────────
test('resolveBotImage: ไม่ระบุ = default; ระบุได้เฉพาะ bot ชื่อขึ้นต้น test และ repo เดียวกัน', () => {
  assert.equal(dockerService.resolveBotImage('shop', undefined), config.botImage);
  assert.equal(dockerService.resolveBotImage('shop', ''), config.botImage);
  assert.equal(dockerService.resolveBotImage('test', 'phattadol358/netguard-ai:stats-dev'), 'phattadol358/netguard-ai:stats-dev');
  assert.equal(dockerService.resolveBotImage('test-stats', 'phattadol358/netguard-ai:1.0.0'), 'phattadol358/netguard-ai:1.0.0');
  // bot จริงระบุ image เองไม่ได้
  assert.throws(() => dockerService.resolveBotImage('itmonitor', 'phattadol358/netguard-ai:stats-dev'), (e) => e.statusCode === 403);
  assert.throws(() => dockerService.resolveBotImage('mytest', 'phattadol358/netguard-ai:stats-dev'), (e) => e.statusCode === 403);
  // repo อื่น / รูปแบบแปลก ๆ ไม่ผ่าน
  for (const bad of ['evil/image:latest', 'phattadol358/netguard-ai', 'phattadol358/netguard-ai:', 'phattadol358/netguard-ai:a b',
    'phattadol358/netguard-ai:../x', 'phattadol358/netguard-ai@sha256:abc', 'phattadol358/netguard-ai:-x', 123]) {
    assert.throws(() => dockerService.resolveBotImage('test', bad), (e) => e.statusCode === 400, String(bad));
  }
});

// ── HIKCENTRAL_EVENT_TYPES ผ่าน env-config ──────────────────────────────────────
test('env-config: HIKCENTRAL_EVENT_TYPES รับเฉพาะจำนวนเต็มคั่นด้วย , และกัน newline injection', () => {
  const envConfig = require('../services/env-config');
  const dir = path.join(root, 'test-env');
  fs.mkdirSync(dir, { recursive: true });
  const read = () => fs.readFileSync(path.join(dir, '.env'), 'utf8');

  envConfig.writeEnvConfig('test-env', { HIKCENTRAL_EVENT_TYPES: '131330, 131331,131332' });
  assert.match(read(), /^HIKCENTRAL_EVENT_TYPES=131330, 131331,131332$/m);
  assert.equal(envConfig.readEnvConfig('test-env').HIKCENTRAL_EVENT_TYPES, '131330, 131331,131332');

  for (const bad of ['abc', '1,,2', '1;2', '-5', '1.5', '1,2,', Array.from({ length: 51 }, (_, i) => i + 1).join(',')]) {
    assert.throws(() => envConfig.writeEnvConfig('test-env', { HIKCENTRAL_EVENT_TYPES: bad }), (e) => e.statusCode === 400, bad);
  }
  // newline ถูกตัดทิ้งก่อน validate → ที่เหลือไม่ใช่ตัวเลข ถูกปฏิเสธ และไม่มี key ใหม่หลุดเข้า .env
  assert.throws(() => envConfig.writeEnvConfig('test-env', { HIKCENTRAL_EVENT_TYPES: '131330\nANTHROPIC_API_KEY=evil' }), (e) => e.statusCode === 400);
  assert.doesNotMatch(read(), /ANTHROPIC_API_KEY=evil/);
  // ล้างค่า (null) = ไม่เก็บ event
  envConfig.writeEnvConfig('test-env', { HIKCENTRAL_EVENT_TYPES: null });
  assert.match(read(), /^HIKCENTRAL_EVENT_TYPES=$/m);
});

// ── route /stats/series ─────────────────────────────────────────────────────
test('route /api/bots/:name/stats/series', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', apiRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${guard.SESSION_COOKIE}=${guard.createSession()}`;
  const get = (p, withCookie = true) => fetch(base + p, { headers: withCookie ? { Cookie: cookie } : {} });

  assert.equal((await get('/api/bots/b1/stats/series', false)).status, 401);
  assert.equal((await get('/api/bots/..%2Fx/stats/series')).status, 400);

  const body = await (await get('/api/bots/b1/stats/series?range=7d')).json();
  assert.equal(body.range, '7d');
  assert.equal(body.omada.available, true);
  assert.equal(body.hikcentral.available, true);
  assert.ok(Array.isArray(body.omada.topClients));
  assert.equal(body.hikcentral.topCameras[0].name, 'Cam1');
  assert.equal(body.latest.omada.clients, 10);

  // ช่วงเวลาที่ไม่รู้จัก → ถอยเป็น 24h (ไม่ error)
  assert.equal((await (await get('/api/bots/b1/stats/series?range=999d')).json()).range, '24h');

  // bot ที่ไม่เคยมีข้อมูล → แท็บ omada/hik ไม่ available (frontend จะซ่อน)
  const none = await (await get('/api/bots/ghost/stats/series')).json();
  assert.equal(none.omada.available, false);
  assert.equal(none.hikcentral.available, false);
  assert.deepEqual(none.omada.points, []);
});
