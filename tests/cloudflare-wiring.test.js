// การเดินสาย auto-tunnel เข้า createBot (services/docker.js): flag ปิด = พฤติกรรมเดิมทุกจุด, flag เปิด = preflight → สร้างบอท → tunnel + rollback
// Docker จำลองด้วยการแทน method บน prototype ของ dockerode (ไม่แตะ docker.sock จริง) และ client Cloudflare จำลอง — ไม่เรียก Cloudflare จริง ไม่ใช้ token จริง
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfwire-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.BOTS_HOST_PATH = '/host/bots';
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const Docker = require('dockerode');
const config = require('../config');
const logger = require('../services/logger');
const { CloudflareError } = require('../services/cloudflare');
const realState = require('../services/cloudflare-state');
const botLock = require('../services/bot-lock');
const { createAutoTunnelService } = require('../services/cloudflare-auto');
const dockerService = require('../services/docker');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '11111111-2222-4333-8444-555555555555';
const REC = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'tunneltoken_WIRE_SECRET_0123456789abcdefghij';
const SETTINGS = { enabled: true, accountId: ACCT, zoneId: ZONE, zoneName: 'example.com', reserved: [] };

// ── Docker จำลอง ─────────────────────────────────────────────────────────────
const dockerLog = { created: [], started: [], stopped: [], removed: [], pulled: [] };
let localImages = new Set();
let createContainerHook = null;

function fakeContainer(name) {
  return {
    id: `id-${name}`,
    async start() { dockerLog.started.push(name); },
    async stop() { dockerLog.stopped.push(name); },
    async remove() { dockerLog.removed.push(name); },
    async inspect() { return { Id: `id-${name}`, Name: `/${name}`, Config: { Labels: { 'netguard.managed': 'true', 'netguard.botname': name.replace(/^netguard-/, '') } } }; },
  };
}

const saved = {};
for (const key of ['getNetwork', 'listContainers', 'getImage', 'pull', 'createContainer', 'getContainer']) saved[key] = Docker.prototype[key];
test.before(() => {
  Docker.prototype.getNetwork = () => ({ inspect: async () => ({}) });
  Docker.prototype.listContainers = async () => [];
  Docker.prototype.getImage = (name) => ({
    async inspect() {
      if (!localImages.has(name)) throw Object.assign(new Error('No such image'), { statusCode: 404 });
      return {};
    },
  });
  Docker.prototype.pull = (image, cb) => { dockerLog.pulled.push(image); cb(new Error('pull ต้องไม่ถูกเรียก')); };
  Docker.prototype.createContainer = async (opts) => {
    dockerLog.created.push(opts);
    if (createContainerHook) await createContainerHook(opts);
    return fakeContainer(opts.name);
  };
  Docker.prototype.getContainer = (name) => fakeContainer(name);
});
test.after(() => { Object.assign(Docker.prototype, saved); });

function resetAll() {
  for (const k of Object.keys(dockerLog)) dockerLog[k].length = 0;
  localImages = new Set([config.botImage, config.cloudflaredImage]);
  createContainerHook = null;
  fs.rmSync(process.env.BOTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });
  fs.rmSync(path.dirname(process.env.DB_PATH), { recursive: true, force: true });
}
test.beforeEach(resetAll);
test.afterEach(() => dockerService.setAutoTunnelServiceForTests(null));

// ── Cloudflare จำลอง ─────────────────────────────────────────────────────────
function fakeClient({ failAt = {}, records = [], tunnels = [], gate = null } = {}) {
  const calls = [];
  const maybeFail = (key) => { if (failAt[key]) throw typeof failAt[key] === 'function' ? failAt[key]() : failAt[key]; };
  return {
    calls,
    async findDnsRecords(host) { calls.push('findDnsRecords'); maybeFail('findDnsRecords'); return records; },
    async findTunnelsByName(name) { calls.push('findTunnelsByName'); maybeFail('findTunnelsByName'); return tunnels; },
    async createTunnel() {
      calls.push('createTunnel');
      if (gate) await gate;
      maybeFail('createTunnel');
      const out = { id: TID };
      Object.defineProperty(out, 'token', { value: TOKEN, enumerable: false });
      return out;
    },
    async putIngress() { calls.push('putIngress'); maybeFail('putIngress'); },
    async createCname() { calls.push('createCname'); maybeFail('createCname'); return { id: REC }; },
    async getTunnelToken() { calls.push('getTunnelToken'); return TOKEN; },
    async deleteDnsRecord() { calls.push('deleteDnsRecord'); maybeFail('deleteDnsRecord'); return { deleted: true }; },
    async deleteTunnel() { calls.push('deleteTunnel'); maybeFail('deleteTunnel'); return { deleted: true }; },
  };
}

function install(client, settings = SETTINGS) {
  const svc = createAutoTunnelService({ settings, client, state: realState, ops: dockerService.autoTunnelOps, logger });
  dockerService.setAutoTunnelServiceForTests(svc);
  return svc;
}

const http = (status) => new CloudflareError(`cloudflare op: HTTP ${status}`, { op: 'op', code: 'http', status });

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function captureLogs() {
  const lines = [];
  const orig = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const k of Object.keys(orig)) logger[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(logger, orig) };
}

const botEnv = (name) => fs.readFileSync(path.join(process.env.BOTS_ROOT, name, '.env'), 'utf8');

// ── flag ปิด = พฤติกรรมเดิม ─────────────────────────────────────────────────────
test('flag ปิด: createBot ธรรมดาทำงานเหมือนเดิมทุกอย่าง (คืน {id,name,port} ไม่มี tunnel) และไม่แตะ Cloudflare client/ops เลย', async () => {
  const boom = new Proxy({}, { get: (_, key) => { throw new Error(`client.${String(key)} ถูกเรียกทั้งที่ flag ปิด`); } });
  const opsBoom = new Proxy({}, { get: (_, key) => { throw new Error(`ops.${String(key)} ถูกเรียกทั้งที่ flag ปิด`); } });
  dockerService.setAutoTunnelServiceForTests(createAutoTunnelService({ settings: { ...SETTINGS, enabled: false }, client: boom, state: realState, ops: opsBoom, logger }));
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'plain', port, companyName: 'ACME' });
  assert.deepEqual(bot, { id: 'id-netguard-plain', name: 'netguard-plain', port });
  assert.equal(dockerLog.created.length, 1);
  assert.equal(dockerLog.created[0].Image, config.botImage);
  assert.equal(dockerLog.created[0].name, 'netguard-plain');
  assert.deepEqual(dockerLog.started, ['netguard-plain']);
});

test('flag ปิด + กรอก token เอง (ทางสำรองเดิม): สร้าง cloudflared ด้วย Cmd --token แบบเดิม, ไม่มี Env, เขียน token ลง .env เหมือนเดิม, ไม่มี key tunnel ในผล', async () => {
  dockerService.setAutoTunnelServiceForTests(null); // ค่าเริ่มต้นจาก env จริงของเทสต์ = ปิด
  const port = await freePort();
  const manual = 'manual_tunnel_token_0123456789abcdef';
  const bot = await dockerService.createBot({ name: 'manual', port, tunnelToken: manual });
  assert.deepEqual(bot, { id: 'id-netguard-manual', name: 'netguard-manual', port });
  assert.equal(dockerLog.created.length, 2);
  const tunnel = dockerLog.created[1];
  assert.equal(tunnel.Image, config.cloudflaredImage);
  assert.equal(tunnel.name, 'netguard-manual-cloudflared');
  assert.deepEqual(tunnel.Cmd, ['tunnel', '--no-autoupdate', 'run', '--token', manual]);
  assert.equal(tunnel.Env, undefined);
  assert.match(botEnv('manual'), new RegExp(`CLOUDFLARE_TUNNEL_TOKEN=${manual}`));
  assert.deepEqual(dockerLog.pulled, []); // image อยู่ในเครื่องแล้ว
});

test('flag ปิด + hostname ที่ส่งมาลอยๆ (ไม่ติ๊ก autoTunnel) ถูกมองข้าม ไม่ทำให้พฤติกรรมเปลี่ยน', async () => {
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'plain2', port, hostname: 'plain2.example.com' });
  assert.equal(bot.tunnel, undefined);
  assert.equal(dockerLog.created.length, 1);
});

test('ขอ autoTunnel ทั้งที่ flag ปิด → 403 ไม่สร้างอะไรเลย (ไม่มี container, ไม่เรียก client)', async () => {
  const client = fakeClient();
  install(client, { ...SETTINGS, enabled: false });
  const port = await freePort();
  await assert.rejects(dockerService.createBot({ name: 'nope', port, autoTunnel: true, hostname: 'nope.example.com' }), (e) => e.statusCode === 403 && /not enabled/.test(e.message));
  assert.deepEqual(dockerLog.created, []);
  assert.deepEqual(client.calls, []);
});

test('ขอ autoTunnel พร้อม tunnelToken → 400 (เลือกอย่างใดอย่างหนึ่ง) ไม่สร้างอะไร', async () => {
  const client = fakeClient();
  install(client);
  const port = await freePort();
  await assert.rejects(dockerService.createBot({ name: 'both', port, autoTunnel: true, hostname: 'both.example.com', tunnelToken: 'x'.repeat(30) }), (e) => e.statusCode === 400);
  assert.deepEqual(dockerLog.created, []);
  assert.deepEqual(client.calls, []);
});

test('autoTunnel: ชื่อบอท/พอร์ตผิด → 400 ก่อนยิง Cloudflare', async () => {
  const client = fakeClient();
  install(client);
  await assert.rejects(dockerService.createBot({ name: 'Bad Name', port: 40000, autoTunnel: true, hostname: 'x.example.com' }), (e) => e.statusCode === 400 && /lowercase letters/.test(e.message));
  await assert.rejects(dockerService.createBot({ name: 'okname', port: 80, autoTunnel: true, hostname: 'okname.example.com' }), (e) => e.statusCode === 400 && /between 1024 and 65535/.test(e.message));
  assert.deepEqual(client.calls, []);
});

// ── flag เปิด ───────────────────────────────────────────────────────────────
test('autoTunnel สำเร็จ: preflight → สร้างบอท → tunnel/ingress/DNS → cloudflared ด้วย env TUNNEL_TOKEN (ไม่มี --token) → ผลมี tunnel.ok', async () => {
  const client = fakeClient();
  install(client);
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'Shop.Example.com' });
  assert.equal(bot.id, 'id-netguard-shop');
  assert.deepEqual(bot.tunnel, { status: 'ok', hostname: 'shop.example.com' });
  assert.deepEqual(client.calls, ['findDnsRecords', 'findTunnelsByName', 'createTunnel', 'putIngress', 'createCname']);

  assert.equal(dockerLog.created.length, 2);
  assert.equal(dockerLog.created[0].name, 'netguard-shop');
  const tunnel = dockerLog.created[1];
  assert.equal(tunnel.name, 'netguard-shop-cloudflared');
  assert.equal(tunnel.Image, config.cloudflaredImage);
  assert.deepEqual(tunnel.Env, [`TUNNEL_TOKEN=${TOKEN}`]);
  assert.deepEqual(tunnel.Cmd, ['tunnel', '--no-autoupdate', 'run']);
  assert.ok(!JSON.stringify(tunnel.Cmd).includes(TOKEN));
  assert.deepEqual(tunnel.Labels, { 'netguard.managed': 'true', 'netguard.botname': 'shop', 'netguard.role': 'tunnel' });
  assert.match(botEnv('shop'), new RegExp(`CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}`));
  assert.equal(realState.readState('shop').step, 'complete');
  assert.ok(!JSON.stringify(bot).includes(TOKEN));
  assert.deepEqual(dockerLog.pulled, []);
});

test('preflight ไม่ผ่าน (มี DNS ชื่อนี้อยู่แล้ว) → 409 ไม่สร้างบอท ไม่สร้างอะไรใน Cloudflare', async () => {
  const client = fakeClient({ records: [{ id: 'r1', type: 'A', name: 'shop.example.com', content: '1.2.3.4' }] });
  install(client);
  const port = await freePort();
  await assert.rejects(dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' }), (e) => e.statusCode === 409 && e.code === 'hostname-in-use');
  assert.deepEqual(dockerLog.created, []);
  assert.deepEqual(client.calls, ['findDnsRecords']);
  assert.equal(fs.existsSync(path.join(process.env.BOTS_ROOT, 'shop')), false);
});

test('hostname สงวน (bot.<zone>) → 400 ไม่สร้างบอทและไม่ยิง Cloudflare — แม้ settings.reserved ว่าง', async () => {
  const client = fakeClient();
  install(client);
  const port = await freePort();
  await assert.rejects(dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'bot.example.com' }), (e) => e.statusCode === 400 && e.code === 'reserved-hostname');
  assert.deepEqual(dockerLog.created, []);
  assert.deepEqual(client.calls, []);
});

test('tunnel ล้มกลางทาง → เก็บบอทไว้ (ไม่ลบ container บอท) + rollback Cloudflare + รายงาน tunnel.failed พร้อมขั้น', async () => {
  const client = fakeClient({ failAt: { putIngress: http(400) } });
  install(client);
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' });
  assert.equal(bot.name, 'netguard-shop');
  assert.equal(bot.tunnel.status, 'failed');
  assert.equal(bot.tunnel.step, 'set-ingress');
  assert.equal(bot.tunnel.hostname, 'shop.example.com');
  assert.deepEqual(bot.tunnel.rollback, { ok: true, failed: [], orphaned: false });
  assert.deepEqual(dockerLog.removed, []); // ไม่ลบบอท
  assert.equal(dockerLog.created.length, 1); // ไม่มี cloudflared
  assert.ok(client.calls.includes('deleteTunnel'));
  assert.equal(fs.existsSync(path.join(process.env.BOTS_ROOT, 'shop', 'cloudflare.json')), false);
});

test('ไม่มี image cloudflared ในเครื่อง: ล้มที่ขั้นเริ่ม container โดย "ไม่ pull" แล้ว rollback ทั้งหมด (บอทยังอยู่)', async () => {
  localImages.delete(config.cloudflaredImage);
  const client = fakeClient();
  install(client);
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' });
  assert.equal(bot.tunnel.status, 'failed');
  assert.equal(bot.tunnel.step, 'start-container');
  assert.match(bot.tunnel.message, /not available locally/);
  assert.deepEqual(dockerLog.pulled, []);
  assert.ok(client.calls.includes('deleteDnsRecord') && client.calls.includes('deleteTunnel'));
  assert.doesNotMatch(botEnv('shop'), new RegExp(TOKEN)); // token ที่เขียนไว้ถูกล้างตอน rollback
});

test('rollback ที่ล้มบางขั้น: ลง orphan และรายงานใน tunnel.rollback แต่บอทยังถูกสร้าง', async () => {
  const client = fakeClient({ failAt: { createCname: http(400), deleteTunnel: new Error('cannot delete') } });
  install(client);
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' });
  assert.equal(bot.tunnel.status, 'failed');
  assert.deepEqual(bot.tunnel.rollback, { ok: false, failed: ['tunnel'], orphaned: true });
  const orphans = realState.listOrphans();
  assert.equal(orphans.length, 1);
  assert.deepEqual(orphans[0].leftovers, ['tunnel']);
});

test('สร้างบอทชื่อเดียวกันซ้อนกัน: คำขอที่สองได้ 409 busy ทันที, คำขอแรกสำเร็จ, ล็อกถูกปล่อย', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeClient({ gate });
  install(client);
  const port = await freePort();
  const first = dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' });
  await new Promise((r) => setTimeout(r, 30)); // ให้คำขอแรกเข้าไปถือล็อกและค้างที่ createTunnel
  assert.equal(botLock.isLocked('shop'), true);
  await assert.rejects(dockerService.createBot({ name: 'shop', port: port + 1, autoTunnel: true, hostname: 'shop.example.com' }), (e) => e.statusCode === 409 && e.code === 'busy');
  release();
  const bot = await first;
  assert.equal(bot.tunnel.status, 'ok');
  assert.equal(botLock.isLocked('shop'), false);
});

test('สร้างบอทล้ม (เช่น container สร้างไม่ได้) → ล็อกถูกปล่อย และไม่ได้สร้างอะไรใน Cloudflare นอกจากการตรวจ', async () => {
  const client = fakeClient();
  install(client);
  createContainerHook = async () => { throw new Error('docker said no'); };
  const port = await freePort();
  await assert.rejects(dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' }), /docker said no/);
  assert.equal(botLock.isLocked('shop'), false);
  assert.deepEqual(client.calls, ['findDnsRecords', 'findTunnelsByName']);
});

test('กวาดหา token: ผลลัพธ์ / log / state / orphans / error ของทุกสถานการณ์ใน createBot ไม่มี token (ยกเว้น .env ของบอทและ Env ของ cloudflared ซึ่งเป็นที่ตั้งใจเก็บ)', async () => {
  const scenarios = [
    {},
    { failAt: { putIngress: new Error(`boom ${TOKEN}`) } },
    { failAt: { createCname: http(400), deleteTunnel: new Error(`nope ${TOKEN}`) } },
    { startFails: true },
  ];
  for (const sc of scenarios) {
    resetAll();
    const cap = captureLogs();
    try {
      const client = fakeClient({ failAt: sc.failAt || {} });
      install(client);
      if (sc.startFails) {
        createContainerHook = async (opts) => { if (opts.name.endsWith('-cloudflared')) throw new Error(`docker: invalid env TUNNEL_TOKEN=${TOKEN}`); };
      }
      const port = await freePort();
      let result;
      let thrown = '';
      try { result = await dockerService.createBot({ name: 'shop', port, autoTunnel: true, hostname: 'shop.example.com' }); } catch (e) { thrown = `${e.message}\n${e.stack}`; }
      const statePath = path.join(process.env.BOTS_ROOT, 'shop', 'cloudflare.json');
      const orphans = path.join(path.dirname(process.env.DB_PATH), 'cf-orphans.json');
      const sweep = [
        JSON.stringify(result), thrown, cap.lines.join('\n'),
        fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '',
        fs.existsSync(orphans) ? fs.readFileSync(orphans, 'utf8') : '',
      ].join('\n');
      assert.ok(!sweep.includes(TOKEN), `token รั่วในสถานการณ์ ${JSON.stringify(Object.keys(sc))}`);
    } finally {
      cap.restore();
    }
  }
});

test('image ของ cloudflared ตั้งค่าได้ (config.cloudflaredImage): ทั้งทางอัตโนมัติและทางกรอก token เองใช้ชื่อนั้น; ไม่มีในเครื่องก็ไม่ pull', async () => {
  const custom = 'registry.local/cloudflared:2026.10.0-pinned';
  const original = config.cloudflaredImage;
  config.cloudflaredImage = custom;
  try {
    localImages = new Set([config.botImage, custom]);
    install(fakeClient());
    const port = await freePort();
    await dockerService.createBot({ name: 'imgbot', port, autoTunnel: true, hostname: 'imgbot.example.com' });
    assert.equal(dockerLog.created[1].Image, custom);

    dockerService.setAutoTunnelServiceForTests(null);
    await dockerService.createBot({ name: 'imgbot2', port: await freePort(), tunnelToken: 'manual_tunnel_token_0123456789abcdef' });
    assert.equal(dockerLog.created[3].Image, custom);

    localImages = new Set([config.botImage]); // image ที่ตรึงไว้ไม่มีในเครื่อง
    install(fakeClient());
    const bot = await dockerService.createBot({ name: 'imgbot3', port: await freePort(), autoTunnel: true, hostname: 'imgbot3.example.com' });
    assert.equal(bot.tunnel.status, 'failed');
    assert.ok(bot.tunnel.message.includes(custom));
    assert.deepEqual(dockerLog.pulled, []);
  } finally {
    config.cloudflaredImage = original;
  }
});

test('ตัวแปรที่ส่งออกมา: getAutoTunnelService มีเมธอดที่ route ใช้, autoTunnelOps มีครบสี่ตัว', () => {
  const svc = dockerService.getAutoTunnelService();
  assert.equal(svc.isEnabled(), false);
  for (const key of ['writeEnvToken', 'clearEnvToken', 'startTunnelContainer', 'removeTunnelContainer']) {
    assert.equal(typeof dockerService.autoTunnelOps[key], 'function', key);
  }
});

// ── ops ของ Docker/ไฟล์ที่ตัวประสานงานใช้ ──────────────────────────────────────────
test('ops.removeTunnelContainer: หยุด+ลบ container cloudflared; 304/404 ไม่ใช่ error; error อื่นโยนต่อ', async () => {
  const stops = [];
  const removes = [];
  const behaviours = [
    { stop: { statusCode: 304 }, remove: null, ok: true },
    { stop: { statusCode: 404 }, remove: { statusCode: 404 }, ok: true },
    { stop: { statusCode: 500 }, remove: null, ok: false },
    { stop: null, remove: { statusCode: 500 }, ok: false },
  ];
  for (const b of behaviours) {
    Docker.prototype.getContainer = () => ({
      async stop() { stops.push(1); if (b.stop) throw Object.assign(new Error('stop'), b.stop); },
      async remove() { removes.push(1); if (b.remove) throw Object.assign(new Error('remove'), b.remove); },
    });
    if (b.ok) await dockerService.autoTunnelOps.removeTunnelContainer('shop');
    else await assert.rejects(dockerService.autoTunnelOps.removeTunnelContainer('shop'));
  }
  assert.equal(stops.length, 4);
  assert.equal(removes.length, 3); // รอบที่ stop ล้ม 500 ไม่ไปต่อที่ remove
});

test('ops.writeEnvToken/clearEnvToken: เขียน/ล้างเฉพาะบรรทัด CLOUDFLARE_TUNNEL_TOKEN, ไม่แตะบรรทัดอื่น; ไม่มีไฟล์ .env ก็ไม่ error', async () => {
  const dir = path.join(process.env.BOTS_ROOT, 'envbot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'LINE_CHANNEL_SECRET=keepme\nCLOUDFLARE_TUNNEL_TOKEN=\nZABBIX_URL=http://z\n');
  await dockerService.autoTunnelOps.writeEnvToken('envbot', TOKEN);
  assert.equal(botEnv('envbot'), `LINE_CHANNEL_SECRET=keepme\nCLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\nZABBIX_URL=http://z\n`);
  await dockerService.autoTunnelOps.clearEnvToken('envbot');
  assert.equal(botEnv('envbot'), 'LINE_CHANNEL_SECRET=keepme\nCLOUDFLARE_TUNNEL_TOKEN=\nZABBIX_URL=http://z\n');
  await dockerService.autoTunnelOps.clearEnvToken('no-such-bot'); // ไม่มีไฟล์ → ผ่านเงียบๆ
  assert.equal(fs.existsSync(path.join(process.env.BOTS_ROOT, 'no-such-bot')), false);
});

test('ค่าเริ่มต้น image ของ cloudflared ยังเป็นของเดิม (ไม่เปลี่ยนพฤติกรรมเมื่อไม่ตั้ง CLOUDFLARED_IMAGE)', () => {
  assert.equal(config.cloudflaredImage, process.env.CLOUDFLARED_IMAGE || 'cloudflare/cloudflared:latest');
});
