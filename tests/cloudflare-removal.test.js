// ลบบอท/ลองสร้าง tunnel ใหม่/ล้างรายการค้าง ผ่าน services/docker.js (removeBot, retryAutoTunnel, cleanupCloudflareOrphan)
// Docker จำลองด้วยการแทน method ของ dockerode prototype; Cloudflare จำลองทั้งหมด — ไม่แตะ docker.sock/Cloudflare จริง ไม่ใช้ token จริง
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfremove-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.BOTS_HOST_PATH = '/host/bots';
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const Docker = require('dockerode');
const config = require('../config');
const logger = require('../services/logger');
const realState = require('../services/cloudflare-state');
const botLock = require('../services/bot-lock');
const { createAutoTunnelService } = require('../services/cloudflare-auto');
const dockerService = require('../services/docker');
const { ACCT, ZONE, TID, REC, TOKEN, SETTINGS, http, makeFakes } = require('./helpers/cloudflare-fakes');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// ── Docker จำลอง: บอท netguard-shop มีอยู่ (id "botid") ───────────────────────────
const events = []; // ลำดับเหตุการณ์ทั้งหมด เช่น "stop:botid"
const existing = new Set();
let botBehaviour = {};

function fakeContainer(ref) {
  const name = ref === 'botid' ? 'netguard-shop' : ref;
  // container cloudflared ที่ไม่มีอยู่จริง: stop/remove ตอบ 404 เหมือน Docker จริง
  const gone404 = () => { if (name.endsWith('-cloudflared') && !existing.has(name)) throw Object.assign(new Error('no such container'), { statusCode: 404 }); };
  return {
    id: ref,
    async inspect() {
      if (name.endsWith('-cloudflared') && !existing.has(name)) throw Object.assign(new Error('no such container'), { statusCode: 404 });
      return { Id: ref, Name: `/${name}`, State: { Status: 'running' }, Config: { Labels: { 'netguard.managed': 'true', 'netguard.botname': 'shop' } } };
    },
    async stop() { events.push(`stop:${ref}`); gone404(); if (botBehaviour[`stop:${ref}`]) throw botBehaviour[`stop:${ref}`]; },
    async remove() { events.push(`remove:${ref}`); gone404(); if (botBehaviour[`remove:${ref}`]) throw botBehaviour[`remove:${ref}`]; existing.delete(name); },
    async start() { events.push(`start:${ref}`); },
  };
}

const saved = {};
for (const key of ['getNetwork', 'listContainers', 'getImage', 'pull', 'createContainer', 'getContainer']) saved[key] = Docker.prototype[key];
test.before(() => {
  Docker.prototype.getContainer = (ref) => fakeContainer(ref);
  Docker.prototype.getImage = () => ({ inspect: async () => ({}) });
  Docker.prototype.pull = (image, cb) => cb(new Error('pull ต้องไม่ถูกเรียก'));
  Docker.prototype.createContainer = async (opts) => { events.push(`create:${opts.name}`); existing.add(opts.name); createdOpts.push(opts); return fakeContainer(opts.name); };
});
test.after(() => { Object.assign(Docker.prototype, saved); });
const createdOpts = [];

const botDir = () => path.join(process.env.BOTS_ROOT, 'shop');
const stateFile = () => path.join(botDir(), 'cloudflare.json');
const orphansFile = () => path.join(path.dirname(process.env.DB_PATH), 'cf-orphans.json');

test.beforeEach(() => {
  events.length = 0;
  createdOpts.length = 0;
  existing.clear();
  botBehaviour = {};
  fs.rmSync(process.env.BOTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(botDir(), { recursive: true });
  fs.writeFileSync(path.join(botDir(), '.env'), 'CLOUDFLARE_TUNNEL_TOKEN=\n');
  fs.rmSync(path.dirname(process.env.DB_PATH), { recursive: true, force: true });
});
test.afterEach(() => dockerService.setAutoTunnelServiceForTests(null));

function install(opts = {}, settings = SETTINGS, { realOps = true } = {}) {
  const fakes = makeFakes(opts);
  // ops จริงของ docker.js (ผ่าน Docker จำลอง) แต่ครอบเพื่อบันทึกลำดับลง events
  const ops = realOps ? dockerService.autoTunnelOps : fakes.ops;
  const service = createAutoTunnelService({ settings, client: fakes.client, state: realState, ops, logger: fakes.logger });
  dockerService.setAutoTunnelServiceForTests(service);
  return { ...fakes, service };
}
const seedState = (over = {}) => realState.writeState('shop', {
  accountId: ACCT, zoneId: ZONE, tunnelId: TID, hostname: 'shop.example.com', dnsRecordId: REC, step: 'complete', ...over,
});

// ── removeBot ───────────────────────────────────────────────────────────────
test('บอทไม่มี state + flag ปิด: ลบเหมือนเดิมทุกอย่าง (cloudflared → บอท) คืน undefined ไม่แตะ Cloudflare; deleteCloudflare ถูกมองข้าม', async () => {
  const boom = new Proxy({}, { get: (_, key) => { throw new Error(`client.${String(key)} ถูกเรียก`); } });
  dockerService.setAutoTunnelServiceForTests(createAutoTunnelService({ settings: { ...SETTINGS, enabled: false }, client: boom, state: realState, ops: boom, logger }));
  for (const deleteCloudflare of [undefined, false, true]) {
    events.length = 0;
    const result = await dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare });
    assert.equal(result, undefined);
    assert.deepEqual(events, ['stop:netguard-shop-cloudflared', 'remove:netguard-shop-cloudflared', 'stop:botid', 'remove:botid']);
  }
});

test('บอทไม่มี state + deleteFiles: ลบโฟลเดอร์บอทเหมือนเดิม', async () => {
  await dockerService.removeBot('botid', { deleteFiles: true });
  assert.equal(fs.existsSync(botDir()), false);
});

test('มี state + deleteCloudflare=true + เปิดอยู่: หยุด cloudflared → ลบ DNS → ลบ tunnel → ลบบอท ตามลำดับ; state หาย; คืนสถานะ cloudflare', async () => {
  seedState();
  existing.add('netguard-shop-cloudflared');
  const h = install();
  const order = [];
  const origDns = h.client.deleteDnsRecord;
  h.client.deleteDnsRecord = async (...a) => { order.push('cf:dns'); return origDns(...a); };
  const origTun = h.client.deleteTunnel;
  h.client.deleteTunnel = async (...a) => { order.push('cf:tunnel'); return origTun(...a); };
  const origRemove = Docker.prototype.getContainer;
  Docker.prototype.getContainer = (ref) => { const c = origRemove(ref); const rm = c.remove; c.remove = async () => { await rm.call(c); order.push(`docker:remove:${ref}`); }; return c; };
  try {
    const result = await dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare: true });
    assert.deepEqual(result, { cloudflare: { status: 'removed', rollback: { ok: true, failed: [], orphaned: false } } });
  } finally {
    Docker.prototype.getContainer = origRemove;
  }
  assert.deepEqual(order, ['docker:remove:netguard-shop-cloudflared', 'cf:dns', 'cf:tunnel', 'docker:remove:botid']);
  assert.equal(fs.existsSync(stateFile()), false);
  assert.equal(fs.existsSync(orphansFile()), false);
  assert.match(fs.readFileSync(path.join(botDir(), '.env'), 'utf8'), /CLOUDFLARE_TUNNEL_TOKEN=\n/);
});

test('มี state + deleteCloudflare=true แต่ลบ Cloudflare ล้มบางขั้น: บอทยังถูกลบ, ลง orphan, รายงาน partial', async () => {
  seedState();
  install({ failAt: { deleteTunnel: http(500) } });
  const result = await dockerService.removeBot('botid', { deleteFiles: true, deleteCloudflare: true });
  assert.equal(result.cloudflare.status, 'partial');
  assert.deepEqual(result.cloudflare.rollback, { ok: false, failed: ['tunnel'], orphaned: true });
  assert.ok(events.includes('remove:botid'));
  assert.equal(fs.existsSync(botDir()), false);
  const [o] = realState.listOrphans();
  assert.deepEqual(o.leftovers, ['tunnel']);
});

test('มี state + deleteCloudflare=true แต่ flag ปิด → 409 และ "ไม่ลบอะไรเลย" (บอท/state อยู่ครบ)', async () => {
  seedState();
  const h = install({}, { ...SETTINGS, enabled: false });
  await assert.rejects(dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare: true }), (e) => e.statusCode === 409);
  assert.deepEqual(events, []);
  assert.deepEqual(h.calls, []);
  assert.equal(fs.existsSync(stateFile()), true);
});

test('มี state + ไม่ลบ Cloudflare + ลบไฟล์ด้วย: ลง orphan ก่อน (ไม่ให้ tunnel/DNS ที่ค้างหายเงียบ) แล้วลบบอท โดยไม่เรียก Cloudflare', async () => {
  seedState();
  const h = install();
  for (const deleteCloudflare of [undefined, false]) {
    seedState();
    fs.rmSync(orphansFile(), { force: true });
    fs.mkdirSync(botDir(), { recursive: true });
    const result = await dockerService.removeBot('botid', { deleteFiles: true, deleteCloudflare });
    assert.equal(result.cloudflare.status, 'kept');
    assert.deepEqual(realState.listOrphans().map((o) => o.leftovers), [['dns', 'tunnel']]);
    assert.equal(fs.existsSync(botDir()), false);
  }
  assert.deepEqual(h.calls, []);
});

test('มี state + ไม่ลบ Cloudflare + ไม่ลบไฟล์: state ยังอยู่กับโฟลเดอร์บอท ไม่มี orphan; ลบแต่ container', async () => {
  seedState();
  const h = install();
  const result = await dockerService.removeBot('botid', { deleteFiles: false });
  assert.deepEqual(result, { cloudflare: { status: 'kept' } });
  assert.equal(fs.existsSync(stateFile()), true);
  assert.equal(fs.existsSync(orphansFile()), false);
  assert.deepEqual(h.calls, []);
});

test('state เสีย → ปฏิเสธการลบ (409 state-unreadable) ไม่ลบอะไร', async () => {
  fs.writeFileSync(stateFile(), '{broken');
  install();
  await assert.rejects(dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare: true }), (e) => e.statusCode === 409 && e.code === 'state-unreadable');
  assert.deepEqual(events, []);
});

test('ลบบอทที่มี state ขณะมีงานอื่นถือล็อกชื่อเดียวกัน → 409 busy ไม่ลบอะไร', async () => {
  seedState();
  install();
  const release = botLock.acquire('shop');
  try {
    await assert.rejects(dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare: true }), (e) => e.statusCode === 409 && e.code === 'busy');
  } finally {
    release();
  }
  assert.deepEqual(events, []);
  assert.equal(botLock.isLocked('shop'), false);
});

test('ลบ Cloudflare สำเร็จแต่ลบ container บอทล้ม → error ส่งต่อ, ล็อกถูกปล่อย (Cloudflare ถูกลบไปแล้ว ไม่มี orphan)', async () => {
  seedState();
  install();
  botBehaviour['stop:botid'] = Object.assign(new Error('docker down'), { statusCode: 500 });
  await assert.rejects(dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare: true }), /docker down/);
  assert.equal(botLock.isLocked('shop'), false);
  assert.equal(fs.existsSync(orphansFile()), false);
});

test('กวาดหา token ตอนลบบอท: ผลลัพธ์/log/orphan ไม่มี token แม้ error มี token ปน', async () => {
  seedState();
  const h = install({ failAt: { deleteDnsRecord: new Error('a'), deleteTunnel: new Error('b') }, leak: true });
  const result = await dockerService.removeBot('botid', { deleteFiles: false, deleteCloudflare: true });
  const sweep = [JSON.stringify(result), h.logs.join('\n'), fs.readFileSync(orphansFile(), 'utf8')].join('\n');
  assert.ok(!sweep.includes(TOKEN));
});

// ── retryAutoTunnel ─────────────────────────────────────────────────────────
test('retryAutoTunnel: ปฏิเสธเมื่อ flag ปิด (403) โดยยังไม่แตะ Docker เลย', async () => {
  install({}, { ...SETTINGS, enabled: false });
  const orig = Docker.prototype.getContainer;
  Docker.prototype.getContainer = () => { throw new Error('Docker ถูกเรียกทั้งที่ flag ปิด'); };
  try {
    await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.statusCode === 403 && /not enabled/.test(e.message));
  } finally {
    Docker.prototype.getContainer = orig;
  }
});

test('retryAutoTunnel: ชื่อผิด (400) / ไม่มีบอท (404 พร้อมข้อความ not found) / มี cloudflared อยู่แล้ว (409)', async () => {
  const h = install();
  await assert.rejects(dockerService.retryAutoTunnel('Bad Name', 'x.example.com'), (e) => e.statusCode === 400 && /Invalid bot name/.test(e.message));
  const orig = Docker.prototype.getContainer;
  Docker.prototype.getContainer = (ref) => ({ ...orig(ref), inspect: async () => { throw Object.assign(new Error('gone'), { statusCode: 404 }); } });
  try {
    await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.statusCode === 404 && /not found/.test(e.message));
  } finally {
    Docker.prototype.getContainer = orig;
  }
  existing.add('netguard-shop-cloudflared');
  await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.statusCode === 409);
  assert.deepEqual(h.calls, []);
});

test('retryAutoTunnel สำเร็จ: preflight → provision → cloudflared ด้วย env TUNNEL_TOKEN; คืน {status:"ok"}', async () => {
  const h = install();
  const result = await dockerService.retryAutoTunnel('shop', 'Shop.Example.com');
  assert.deepEqual(result, { status: 'ok', hostname: 'shop.example.com' });
  assert.deepEqual(h.calls.slice(0, 2), ['findDnsRecords', 'findTunnelsByName']);
  const tunnel = createdOpts.find((o) => o.name === 'netguard-shop-cloudflared');
  assert.deepEqual(tunnel.Env, [`TUNNEL_TOKEN=${TOKEN}`]);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(botLock.isLocked('shop'), false);
});

test('retryAutoTunnel ล้มกลางทาง: คืน {status:"failed", step, rollback} (ไม่ throw) เพื่อให้ route ตอบ 502 พร้อมรายละเอียด', async () => {
  const h = install({ failAt: { createCname: http(400) } });
  const result = await dockerService.retryAutoTunnel('shop', 'shop.example.com');
  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'create-dns');
  assert.deepEqual(result.rollback, { ok: true, failed: [], orphaned: false });
  assert.ok(h.calls.includes('deleteTunnel'));
});

test('retryAutoTunnel: preflight ไม่ผ่าน (DNS ชนชื่อ) → 409 ไม่สร้างอะไร', async () => {
  const h = install({ findRecords: [{ id: 'r1', type: 'A', name: 'shop.example.com', content: '1.2.3.4' }] });
  await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.statusCode === 409);
  assert.deepEqual(h.calls, ['findDnsRecords']);
});

test('retryAutoTunnel: state ค้างจากความพยายามเดิมที่ไม่จบ → ล้างก่อนแล้วสร้างใหม่; ล้างไม่ครบ → 409 และไม่สร้างต่อ', async () => {
  seedState({ step: 'ingress-set', dnsRecordId: null });
  const ok = install();
  const result = await dockerService.retryAutoTunnel('shop', 'shop.example.com');
  assert.equal(result.status, 'ok');
  assert.ok(ok.calls.indexOf('deleteTunnel') < ok.calls.indexOf('createTunnel'));

  fs.rmSync(stateFile(), { force: true });
  seedState({ step: 'ingress-set', dnsRecordId: null });
  existing.delete('netguard-shop-cloudflared');
  const bad = install({ failAt: { deleteTunnel: http(500) } });
  await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.statusCode === 409 && e.code === 'cleanup-incomplete');
  assert.ok(!bad.calls.includes('createTunnel'));
});

test('retryAutoTunnel: state สมบูรณ์อยู่แล้วแต่ไม่มี container → 409 state-exists (ไม่สร้างซ้ำทับ)', async () => {
  seedState();
  const h = install();
  await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.statusCode === 409 && e.code === 'state-exists');
  assert.deepEqual(h.calls, []);
});

test('retryAutoTunnel ซ้อนกับงานอื่นของบอทเดียวกัน → 409 busy', async () => {
  install();
  const release = botLock.acquire('shop');
  try {
    await assert.rejects(dockerService.retryAutoTunnel('shop', 'shop.example.com'), (e) => e.code === 'busy');
  } finally {
    release();
  }
});

// ── รายการค้าง ──────────────────────────────────────────────────────────────
test('listCloudflareOrphans/cleanupCloudflareOrphan: ใช้ล็อกของบอทเจ้าของรายการ, ไม่พบ 404, flag ปิด 403', async () => {
  realState.addOrphan({ botName: 'shop', hostname: 'shop.example.com', tunnelId: TID, dnsRecordId: REC, accountId: ACCT, zoneId: ZONE, reason: 'x', leftovers: ['dns', 'tunnel'] });
  const h = install();
  assert.equal(dockerService.listCloudflareOrphans().length, 1);

  const release = botLock.acquire('shop');
  try {
    await assert.rejects(dockerService.cleanupCloudflareOrphan(TID), (e) => e.code === 'busy');
  } finally {
    release();
  }
  assert.deepEqual(h.calls, []);

  assert.deepEqual(await dockerService.cleanupCloudflareOrphan(TID), { status: 'cleaned', failed: [] });
  assert.deepEqual(h.calls, ['deleteDnsRecord', 'deleteTunnel']);
  assert.equal(botLock.isLocked('shop'), false);
  await assert.rejects(dockerService.cleanupCloudflareOrphan(TID), (e) => e.statusCode === 404);

  install({}, { ...SETTINGS, enabled: false });
  await assert.rejects(dockerService.cleanupCloudflareOrphan(TID), (e) => e.statusCode === 403);
});

test('บอทที่ชื่อใน label ไม่ใช่รูปแบบบอทของ Manager (เช่นสร้างนอก Manager): ลบแบบเดิม ไม่ไปอ่าน state และไม่ error', async () => {
  const orig = Docker.prototype.getContainer;
  Docker.prototype.getContainer = (ref) => ({
    ...orig(ref),
    async inspect() { return { Id: ref, Name: '/netguard-Odd_Name', Config: { Labels: { 'netguard.managed': 'true', 'netguard.botname': 'Odd_Name' } } }; },
  });
  try {
    const boom = new Proxy({}, { get: (_, key) => { throw new Error(`client.${String(key)} ถูกเรียก`); } });
    dockerService.setAutoTunnelServiceForTests(createAutoTunnelService({ settings: SETTINGS, client: boom, state: realState, ops: boom, logger }));
    assert.equal(await dockerService.removeBot('oddid', { deleteFiles: false, deleteCloudflare: true }), undefined);
    assert.deepEqual(events, ['stop:netguard-Odd_Name-cloudflared', 'remove:netguard-Odd_Name-cloudflared', 'stop:oddid', 'remove:oddid']);
  } finally {
    Docker.prototype.getContainer = orig;
  }
});
