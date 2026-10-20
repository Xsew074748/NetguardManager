// ตัวประสานงาน auto-tunnel (services/cloudflare-auto.js): provision ทีละขั้น + เขียน state ล่วงหน้า + rollback ตามลำดับ
// ทุกอย่างฉีดได้: client Cloudflare จำลอง, ops ของ Docker จำลอง, logger จับข้อความ — ไม่เรียก Cloudflare/Docker จริง และไม่ต้องใช้ token จริง
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfauto-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(path.join(process.env.BOTS_ROOT, 'shop'), { recursive: true });

const { CloudflareError } = require('../services/cloudflare');
const realState = require('../services/cloudflare-state');
const { createAutoTunnelService } = require('../services/cloudflare-auto');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '11111111-2222-4333-8444-555555555555';
const REC = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'tunneltoken_SECRET_0123456789abcdefghij_ZZZ';
const PLAN = { hostname: 'shop.example.com', tunnelName: 'netguard-shop', service: 'http://netguard-shop:3000' };
const SETTINGS = { enabled: true, accountId: ACCT, zoneId: ZONE, zoneName: 'example.com', reserved: [] };
const orphansFile = () => path.join(path.dirname(process.env.DB_PATH), 'cf-orphans.json');
const stateFile = (name = 'shop') => path.join(process.env.BOTS_ROOT, name, 'cloudflare.json');

const http = (status, message = 'nope') => new CloudflareError(`cloudflare op: HTTP ${status}`, { op: 'op', code: 'http', status, cfCodes: [1], retryable: status >= 500 });
const timeoutErr = () => new CloudflareError('cloudflare op: timed out', { op: 'op', code: 'timeout', retryable: true });

// failAt: ชื่อเมธอด → error ที่จะโยน (หรือฟังก์ชันคืน error)
function harness({ failAt = {}, tokenFromCreate = true, findTunnels = [], findRecords = [], leak = false, tokenValue = TOKEN } = {}) {
  const calls = [];
  const logs = [];
  const fail = (key) => {
    const f = failAt[key];
    if (!f) return;
    const err = typeof f === 'function' ? f() : f;
    if (leak) err.message += ` [${tokenValue}]`; // error ที่ดันมีค่า token ปนมา
    throw err;
  };
  const rec = (name, ...args) => { calls.push(name); return args; };
  const client = {
    async createTunnel(name) {
      rec('createTunnel', name);
      fail('createTunnel');
      const out = { id: TID };
      Object.defineProperty(out, 'token', { value: tokenFromCreate ? tokenValue : null, enumerable: false });
      return out;
    },
    async getTunnelToken(id) { rec('getTunnelToken', id); fail('getTunnelToken'); return tokenValue; },
    async putIngress(id, body) { rec('putIngress', id, body); fail('putIngress'); },
    async createCname(body) { rec('createCname', body); fail('createCname'); return { id: REC }; },
    async findTunnelsByName(name) { rec('findTunnelsByName', name); fail('findTunnelsByName'); return findTunnels; },
    async findDnsRecords(host) { rec('findDnsRecords', host); fail('findDnsRecords'); return findRecords; },
    async deleteDnsRecord(id, o) { rec('deleteDnsRecord', id, o); fail('deleteDnsRecord'); return { deleted: true, alreadyGone: false }; },
    async deleteTunnel(id, o) { rec('deleteTunnel', id, o); fail('deleteTunnel'); return { deleted: true, alreadyGone: false }; },
  };
  const ops = {
    async writeEnvToken(bot, token) { rec('writeEnvToken'); assert.equal(token, tokenValue); fail('writeEnvToken'); },
    async startTunnelContainer(bot, token) { rec('startTunnelContainer'); assert.equal(token, tokenValue); fail('startTunnelContainer'); },
    async removeTunnelContainer() { rec('removeTunnelContainer'); fail('removeTunnelContainer'); },
    async clearEnvToken() { rec('clearEnvToken'); fail('clearEnvToken'); },
  };
  const logger = {
    info: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push(a.join(' ')),
  };
  const service = createAutoTunnelService({ settings: SETTINGS, client, state: realState, ops, logger });
  return { service, calls, logs, client, ops };
}

function reset() {
  fs.rmSync(stateFile(), { force: true });
  fs.rmSync(orphansFile(), { force: true });
}
test.beforeEach(reset);

const HAPPY_CALLS = ['createTunnel', 'putIngress', 'createCname', 'writeEnvToken', 'startTunnelContainer'];

// ── ปิดอยู่: ห้ามแตะ Cloudflare เลย ───────────────────────────────────────────────
test('flag ปิด: isEnabled=false และทุกเมธอดที่ทำงานจริงปฏิเสธ 403 โดยไม่แตะ client/ops/state (client จำลอง throw ทุกเมธอด)', async () => {
  const boom = new Proxy({}, { get: (_, key) => { throw new Error(`client.${String(key)} ถูกเรียกทั้งที่ flag ปิด`); } });
  const opsBoom = new Proxy({}, { get: (_, key) => { throw new Error(`ops.${String(key)} ถูกเรียกทั้งที่ flag ปิด`); } });
  const svc = createAutoTunnelService({ settings: { ...SETTINGS, enabled: false }, client: boom, state: realState, ops: opsBoom, logger: console });
  assert.equal(svc.isEnabled(), false);
  assert.deepEqual(svc.features(), { cloudflareAutoTunnel: false });
  await assert.rejects(svc.preflight('shop', 'shop.example.com'), (e) => e.statusCode === 403 && e.code === 'disabled');
  await assert.rejects(svc.provision('shop', PLAN), (e) => e.statusCode === 403 && e.code === 'disabled');
  assert.equal(fs.existsSync(stateFile()), false);
});

test('features(): เปิด → บอก zone name (ไม่ลับ) เท่านั้น ไม่มี ID/token', () => {
  const { service } = harness();
  assert.deepEqual(service.features(), { cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
});

// ── preflight ผ่าน service ────────────────────────────────────────────────────────
test('preflight: ใช้ zone/reserved จาก settings; "bot" สงวนเสมอแม้ settings.reserved ว่าง; hostname ว่างผ่านและคืน plan', async () => {
  const { service, calls } = harness();
  const plan = await service.preflight('shop', 'Shop.example.com');
  assert.deepEqual(plan, PLAN);
  assert.deepEqual(calls, ['findDnsRecords', 'findTunnelsByName']);
  await assert.rejects(service.preflight('shop', 'bot.example.com'), (e) => e.code === 'reserved-hostname');
});

// ── provision: ทางปกติ ───────────────────────────────────────────────────────────
test('provision สำเร็จ: ลำดับ tunnel → ingress → DNS → .env → container; state ลงท้าย complete; ผลลัพธ์ไม่มี token', async () => {
  const { service, calls, client } = harness();
  const result = await service.provision('shop', PLAN);
  assert.deepEqual(result, { status: 'ok', hostname: 'shop.example.com', tunnelId: TID });
  assert.deepEqual(calls, HAPPY_CALLS);
  const st = realState.readState('shop');
  assert.equal(st.step, 'complete');
  assert.equal(st.tunnelId, TID);
  assert.equal(st.dnsRecordId, REC);
  assert.equal(st.hostname, 'shop.example.com');
  assert.equal(st.accountId, ACCT);
  assert.equal(st.zoneId, ZONE);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!fs.readFileSync(stateFile(), 'utf8').includes(TOKEN));
  assert.equal(fs.existsSync(orphansFile()), false);
  assert.ok(client);
});

test('provision: payload ของแต่ละขั้นตรงแผน (ชื่อ tunnel, ingress → service ของบอท, CNAME + comment บอกเจ้าของ)', async () => {
  const seen = {};
  const h = harness();
  const origIngress = h.client.putIngress;
  h.client.putIngress = async (id, body) => { seen.ingress = [id, body]; return origIngress(id, body); };
  const origCname = h.client.createCname;
  h.client.createCname = async (body) => { seen.cname = body; return origCname(body); };
  await h.service.provision('shop', PLAN);
  assert.deepEqual(seen.ingress, [TID, { hostname: 'shop.example.com', service: 'http://netguard-shop:3000' }]);
  assert.equal(seen.cname.hostname, 'shop.example.com');
  assert.equal(seen.cname.tunnelId, TID);
  assert.match(seen.cname.comment, /netguard-manager/);
  assert.match(seen.cname.comment, /shop/);
  assert.ok(seen.cname.comment.length <= 100);
});

test('provision: เขียน state ล่วงหน้า — ก่อนแต่ละขั้นถัดไป state ต้องมีขั้นก่อนหน้าแล้ว (ล้มกลางทางแล้วตามเก็บกวาดได้)', async () => {
  const h = harness();
  const check = (label, expectStep, expectDns) => {
    const st = realState.readState('shop');
    assert.ok(st, `${label}: ต้องมี state แล้ว`);
    assert.equal(st.step, expectStep, label);
    assert.equal(st.tunnelId, TID, label);
    assert.equal(st.dnsRecordId, expectDns, label);
  };
  const ingress = h.client.putIngress;
  h.client.putIngress = async (...a) => { check('ก่อน ingress', 'tunnel-created', null); return ingress(...a); };
  const cname = h.client.createCname;
  h.client.createCname = async (...a) => { check('ก่อน DNS', 'ingress-set', null); return cname(...a); };
  const write = h.ops.writeEnvToken;
  h.ops.writeEnvToken = async (...a) => { check('ก่อนเขียน .env', 'dns-created', REC); return write(...a); };
  const start = h.ops.startTunnelContainer;
  h.ops.startTunnelContainer = async (...a) => { check('ก่อนเริ่ม container', 'dns-created', REC); return start(...a); };
  assert.equal((await h.service.provision('shop', PLAN)).status, 'ok');
});

test('provision: createTunnel ไม่ส่ง token กลับมา → ขอจาก getTunnelToken', async () => {
  const { service, calls } = harness({ tokenFromCreate: false });
  assert.equal((await service.provision('shop', PLAN)).status, 'ok');
  assert.deepEqual(calls, ['createTunnel', 'putIngress', 'createCname', 'getTunnelToken', 'writeEnvToken', 'startTunnelContainer']);
});

test('provision: plan ที่ผิดรูปแบบ/ชื่อบอทไม่ตรงกับ plan → ปฏิเสธก่อนแตะอะไร', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.provision('shop', { ...PLAN, tunnelName: 'netguard-other' }), (e) => e.statusCode === 400);
  await assert.rejects(service.provision('shop', { ...PLAN, hostname: 'bad host' }), (e) => e.statusCode === 400);
  await assert.rejects(service.provision('shop', { ...PLAN, service: 'http://evil:3000' }), (e) => e.statusCode === 400);
  await assert.rejects(service.provision('Bad Name', PLAN), (e) => e.statusCode === 400);
  await assert.rejects(service.provision('shop', null), (e) => e.statusCode === 400);
  assert.deepEqual(calls, []);
});

// ── provision ล้มแต่ละขั้น → rollback ตามลำดับ (container → DNS → tunnel → .env) เฉพาะสิ่งที่สร้างไปแล้ว ─────────────────
const FAIL_STEPS = [
  // [ชื่อขั้นที่รายงาน, เมธอดที่ล้ม, cleanup ที่คาด]
  ['set-ingress', 'putIngress', ['deleteTunnel']],
  ['create-dns', 'createCname', ['deleteTunnel']],
  ['write-env', 'writeEnvToken', ['deleteDnsRecord', 'deleteTunnel', 'clearEnvToken']],
  ['start-container', 'startTunnelContainer', ['removeTunnelContainer', 'deleteDnsRecord', 'deleteTunnel', 'clearEnvToken']],
];

for (const [step, method, cleanup] of FAIL_STEPS) {
  test(`ล้มที่ ${step}: rollback ${cleanup.join(' → ')} แล้วลบ state; ไม่มี orphan; รายงาน failed พร้อมขั้น`, async () => {
    const { service, calls } = harness({ failAt: { [method]: http(400) } });
    const result = await service.provision('shop', PLAN);
    assert.equal(result.status, 'failed');
    assert.equal(result.step, step);
    assert.equal(result.hostname, 'shop.example.com');
    assert.deepEqual(result.rollback, { ok: true, failed: [], orphaned: false });
    const done = calls.slice(calls.indexOf(method) + 1);
    assert.deepEqual(done, cleanup);
    assert.equal(fs.existsSync(stateFile()), false);
    assert.equal(fs.existsSync(orphansFile()), false);
  });
}

test('ล้มที่ get-token: rollback DNS → tunnel (ยังไม่มีอะไรใน .env/container)', async () => {
  const { service, calls } = harness({ tokenFromCreate: false, failAt: { getTunnelToken: http(500) } });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.step, 'get-token');
  assert.deepEqual(calls.slice(calls.indexOf('getTunnelToken') + 1), ['deleteDnsRecord', 'deleteTunnel']);
});

test('rollback เรียก delete ด้วย guard ครบ: DNS ต้องส่ง hostname+tunnelId, tunnel ต้องส่ง expectedName=netguard-<บอท>', async () => {
  const h = harness({ failAt: { startTunnelContainer: http(400) } });
  const seen = [];
  const dns = h.client.deleteDnsRecord;
  h.client.deleteDnsRecord = async (id, o) => { seen.push(['dns', id, o]); return dns(id, o); };
  const tun = h.client.deleteTunnel;
  h.client.deleteTunnel = async (id, o) => { seen.push(['tunnel', id, o]); return tun(id, o); };
  await h.service.provision('shop', PLAN);
  assert.deepEqual(seen, [
    ['dns', REC, { hostname: 'shop.example.com', tunnelId: TID }],
    ['tunnel', TID, { expectedName: 'netguard-shop' }],
  ]);
});

test('createTunnel ล้มแบบชัดเจน (HTTP 4xx): ไม่มีอะไรถูกสร้าง → ไม่มี cleanup, ไม่มี state, ไม่มี orphan', async () => {
  const { service, calls } = harness({ failAt: { createTunnel: http(403) } });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.step, 'create-tunnel');
  assert.deepEqual(calls, ['createTunnel']);
  assert.equal(fs.existsSync(stateFile()), false);
  assert.equal(fs.existsSync(orphansFile()), false);
});

// ── คำขอสร้างที่ผลไม่แน่ชัด (timeout/5xx/error แปลก) → ตรวจสถานะจริงก่อนสรุป ─────────────────────────────
for (const [label, mk] of [['timeout', timeoutErr], ['HTTP 502', () => http(502)], ['error ทั่วไป', () => new Error('socket hang up')]]) {
  test(`createTunnel ${label} (ผลไม่แน่ชัด): พบ tunnel ชื่อ netguard-shop → รับมาเป็นของเรา แล้ว rollback ลบมันทิ้ง`, async () => {
    const { service, calls } = harness({ failAt: { createTunnel: mk }, findTunnels: [{ id: TID, name: 'netguard-shop' }] });
    const result = await service.provision('shop', PLAN);
    assert.equal(result.status, 'failed');
    assert.equal(result.step, 'create-tunnel');
    assert.deepEqual(calls, ['createTunnel', 'findTunnelsByName', 'deleteTunnel']);
    assert.deepEqual(result.rollback, { ok: true, failed: [], orphaned: false });
    assert.equal(fs.existsSync(stateFile()), false);
  });
}

test('createTunnel ผลไม่แน่ชัด และตรวจแล้วไม่พบ tunnel → ไม่มีอะไรต้องลบ', async () => {
  const { service, calls } = harness({ failAt: { createTunnel: timeoutErr }, findTunnels: [] });
  const result = await service.provision('shop', PLAN);
  assert.deepEqual(calls, ['createTunnel', 'findTunnelsByName']);
  assert.equal(result.rollback.ok, true);
});

test('createTunnel ผลไม่แน่ชัด และตรวจสถานะก็ล้ม → รายงาน rollback.unknown + log error (ไม่เงียบ) ไม่ลบอะไรมั่ว', async () => {
  const { service, calls, logs } = harness({ failAt: { createTunnel: timeoutErr, findTunnelsByName: http(403) } });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.status, 'failed');
  assert.equal(result.rollback.unknown, true);
  assert.deepEqual(calls, ['createTunnel', 'findTunnelsByName']);
  assert.ok(logs.some((l) => /netguard-shop/.test(l) && /check/i.test(l)));
});

test('createTunnel ผลไม่แน่ชัด แต่พบ tunnel มากกว่าหนึ่งตัว → ไม่เดา ไม่ลบ รายงาน unknown', async () => {
  const { service, calls } = harness({
    failAt: { createTunnel: timeoutErr },
    findTunnels: [{ id: TID, name: 'netguard-shop' }, { id: '22222222-2222-4333-8444-555555555555', name: 'netguard-shop' }],
  });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.rollback.unknown, true);
  assert.ok(!calls.includes('deleteTunnel'));
});

test('createCname ผลไม่แน่ชัด: พบ CNAME ที่ชี้ tunnel ของเรา → รับมาแล้วลบ DNS + tunnel', async () => {
  const { service, calls } = harness({
    failAt: { createCname: timeoutErr },
    findRecords: [{ id: REC, type: 'CNAME', name: 'shop.example.com', content: `${TID}.cfargotunnel.com` }],
  });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.step, 'create-dns');
  assert.deepEqual(calls.slice(calls.indexOf('createCname') + 1), ['findDnsRecords', 'deleteDnsRecord', 'deleteTunnel']);
  assert.deepEqual(result.rollback, { ok: true, failed: [], orphaned: false });
});

test('createCname ผลไม่แน่ชัด: record ชื่อเดียวกันที่ไม่ใช่ของเรา → ไม่ลบมัน (ลบแต่ tunnel)', async () => {
  const { service, calls } = harness({
    failAt: { createCname: timeoutErr },
    findRecords: [{ id: REC, type: 'CNAME', name: 'shop.example.com', content: 'somewhere-else.example.net' }],
  });
  await service.provision('shop', PLAN);
  assert.ok(!calls.includes('deleteDnsRecord'));
  assert.ok(calls.includes('deleteTunnel'));
});

test('createCname ผลไม่แน่ชัด และตรวจ DNS ไม่ได้ → ลบ tunnel แต่รายงาน unknown + log error', async () => {
  const { service, calls, logs } = harness({ failAt: { createCname: timeoutErr, findDnsRecords: http(403) } });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.rollback.unknown, true);
  assert.ok(!calls.includes('deleteDnsRecord'));
  assert.ok(calls.includes('deleteTunnel'));
  assert.ok(logs.some((l) => /shop\.example\.com/.test(l)));
});

// ── rollback ล้มสลับกันทุกชุด (16 แบบ): ต้องลองครบทุกขั้นเสมอ, ลง orphan ตรงกับที่ล้ม, ไม่เงียบ ───────────────────────
const ROLLBACK = [
  ['container', 'removeTunnelContainer'],
  ['dns', 'deleteDnsRecord'],
  ['tunnel', 'deleteTunnel'],
  ['env-token', 'clearEnvToken'],
];

for (let mask = 0; mask < 16; mask++) {
  const failing = ROLLBACK.filter((_, i) => mask & (1 << i));
  test(`rollback ล้มชุด [${failing.map((f) => f[0]).join(', ') || 'ไม่มี'}]: ลองครบทุกขั้น และลง orphan ตรงกับที่ล้ม`, async () => {
    const failAt = { startTunnelContainer: http(400) };
    for (const [, method] of failing) failAt[method] = new Error(`${method} exploded`);
    const { service, calls, logs } = harness({ failAt });
    const result = await service.provision('shop', PLAN);

    assert.equal(result.status, 'failed');
    assert.equal(result.step, 'start-container');
    // ลองครบทั้งสี่ขั้นตามลำดับ แม้ขั้นก่อนหน้าล้ม
    assert.deepEqual(calls.slice(calls.indexOf('startTunnelContainer') + 1), ROLLBACK.map((r) => r[1]));

    const failedNames = failing.map((f) => f[0]);
    assert.deepEqual(result.rollback.failed, failedNames);
    if (failing.length === 0) {
      assert.equal(result.rollback.ok, true);
      assert.equal(result.rollback.orphaned, false);
      assert.equal(fs.existsSync(orphansFile()), false);
      assert.equal(fs.existsSync(stateFile()), false);
    } else {
      assert.equal(result.rollback.ok, false);
      assert.equal(result.rollback.orphaned, true);
      const orphans = realState.listOrphans();
      assert.equal(orphans.length, 1);
      assert.equal(orphans[0].botName, 'shop');
      assert.equal(orphans[0].tunnelId, TID);
      assert.equal(orphans[0].hostname, 'shop.example.com');
      assert.deepEqual(orphans[0].leftovers, failedNames);
      assert.equal(orphans[0].dnsRecordId, failedNames.includes('dns') ? REC : null);
      assert.equal(fs.existsSync(stateFile()), false, 'ลง orphan แล้วไม่ต้องเก็บ state ซ้ำ');
      for (const name of failedNames) {
        assert.ok(logs.some((l) => l.includes(name) && l.includes('shop')), `ต้อง log ขั้นที่ล้ม: ${name}`);
      }
    }
  });
}

test('ถ้าลง orphan ไม่ได้ (ไฟล์ orphans เสีย) → เก็บ state ไว้ไม่ให้ข้อมูลหาย + log error + รายงาน orphaned=false', async () => {
  fs.mkdirSync(path.dirname(orphansFile()), { recursive: true });
  fs.writeFileSync(orphansFile(), '{broken');
  const { service, logs } = harness({ failAt: { startTunnelContainer: http(400), deleteTunnel: new Error('nope') } });
  const result = await service.provision('shop', PLAN);
  assert.deepEqual(result.rollback.failed, ['tunnel']);
  assert.equal(result.rollback.orphaned, false);
  assert.equal(fs.existsSync(stateFile()), true);
  assert.ok(logs.some((l) => /orphan/i.test(l)));
  assert.equal(fs.readFileSync(orphansFile(), 'utf8'), '{broken');
});

test('เขียน state ไม่ได้กลางทาง (ขั้น container-started) → ถือว่าล้มและ rollback เต็มชุด', async () => {
  const flaky = {
    ...realState,
    updateState: (name, patch) => {
      if (patch.step === 'container-started') throw new Error('disk full');
      return realState.updateState(name, patch);
    },
  };
  const h = harness();
  const service = createAutoTunnelService({ settings: SETTINGS, client: h.client, state: flaky, ops: h.ops, logger: { info() {}, warn() {}, error() {} } });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'save-state');
  assert.deepEqual(h.calls.slice(h.calls.indexOf('startTunnelContainer') + 1), ['removeTunnelContainer', 'deleteDnsRecord', 'deleteTunnel', 'clearEnvToken']);
});

test('เขียน state แรกไม่ได้ (ทันทีหลังสร้าง tunnel) → ลบ tunnel ที่เพิ่งสร้างทันทีด้วยข้อมูลในหน่วยความจำ', async () => {
  const broken = { ...realState, writeState: () => { throw new Error('read-only fs'); } };
  const h = harness();
  const service = createAutoTunnelService({ settings: SETTINGS, client: h.client, state: broken, ops: h.ops, logger: { info() {}, warn() {}, error() {} } });
  const result = await service.provision('shop', PLAN);
  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'save-state');
  assert.deepEqual(h.calls, ['createTunnel', 'deleteTunnel']);
});

// ── token ต้องไม่โผล่ที่ไหนเลย ────────────────────────────────────────────────────
test('กวาดหา token: ทุกเอาต์พุตของทุกสถานการณ์ (สำเร็จ/ล้มทุกขั้น/rollback ล้ม) ไม่มีสตริง token แม้ error ที่โยนมาจะมี token ปน', async () => {
  const scenarios = [
    {},
    { failAt: { putIngress: http(500) } },
    { failAt: { createCname: http(400) } },
    { failAt: { writeEnvToken: new Error('write failed') } },
    { failAt: { startTunnelContainer: new Error('docker: bad config') } },
    { failAt: { startTunnelContainer: http(400), removeTunnelContainer: new Error('x'), deleteDnsRecord: new Error('y'), deleteTunnel: new Error('z'), clearEnvToken: new Error('w') } },
    { tokenFromCreate: false, failAt: { getTunnelToken: http(502) } },
    { failAt: { createTunnel: timeoutErr, findTunnelsByName: http(403) } },
  ];
  for (const sc of scenarios) {
    reset();
    const h = harness({ ...sc, leak: true });
    let thrown = null;
    let result = null;
    try { result = await h.service.provision('shop', PLAN); } catch (e) { thrown = e; }
    const sweep = [
      JSON.stringify(result),
      thrown ? `${thrown.message}\n${thrown.stack}` : '',
      h.logs.join('\n'),
      fs.existsSync(stateFile()) ? fs.readFileSync(stateFile(), 'utf8') : '',
      fs.existsSync(orphansFile()) ? fs.readFileSync(orphansFile(), 'utf8') : '',
    ].join('\n');
    assert.ok(!sweep.includes(TOKEN), `token รั่วในสถานการณ์ ${JSON.stringify(Object.keys(sc.failAt || {}))}`);
  }
});

test('log ของ provision/rollback บอกขั้นและชื่อบอท/hostname เพื่อให้ตามได้ (ไม่เงียบ)', async () => {
  const { service, logs } = harness({ failAt: { createCname: http(400) } });
  await service.provision('shop', PLAN);
  const text = logs.join('\n');
  assert.match(text, /create-dns/);
  assert.match(text, /shop/);
});

// ── เทสต์เพิ่มจากผล mutation check ────────────────────────────────────────────────
test('provision: ชื่อบอทใน plan ผิดรูปแบบ (แม้ plan สอดคล้องกับชื่อนั้น) → ปฏิเสธ 400', async () => {
  const { service, calls } = harness();
  const bad = 'Bad Name';
  await assert.rejects(service.provision(bad, { hostname: 'shop.example.com', tunnelName: `netguard-${bad}`, service: `http://netguard-${bad}:3000` }), (e) => e.statusCode === 400);
  assert.deepEqual(calls, []);
});

test('provision: hostname ใน plan ต้องเป็น <label>.<zone> ของ settings เท่านั้น', async () => {
  const { service, calls } = harness();
  for (const hostname of ['shop.other.com', 'example.com', 'shopexample.com', 'a.shop.example.com', 'shop.example.com.evil.net', '.example.com', 'Shop.example.com']) {
    await assert.rejects(service.provision('shop', { ...PLAN, hostname }), (e) => e.statusCode === 400 && e.code === 'invalid-plan', hostname);
  }
  assert.deepEqual(calls, []);
});

test('createTunnel ถูกปฏิเสธฝั่ง client เอง (invalid-argument / invalid-id / no-token) = ชัดเจนว่าไม่สร้าง → ไม่ต้องตรวจ tunnel ซ้ำ', async () => {
  for (const code of ['invalid-argument', 'invalid-id', 'no-token']) {
    const { service, calls } = harness({ failAt: { createTunnel: () => new CloudflareError('cloudflare createTunnel: rejected', { op: 'createTunnel', code }) } });
    const result = await service.provision('shop', PLAN);
    assert.equal(result.step, 'create-tunnel');
    assert.deepEqual(calls, ['createTunnel'], code);
  }
});

test('error ที่ไม่ใช่ CloudflareError (แม้มี code/status หน้าตาเหมือน) ถือว่าผลไม่แน่ชัด → ตรวจ tunnel ก่อน', async () => {
  const mk = () => Object.assign(new Error('odd'), { code: 'invalid-id', status: 403 });
  const { service, calls } = harness({ failAt: { createTunnel: mk }, findTunnels: [] });
  await service.provision('shop', PLAN);
  assert.deepEqual(calls, ['createTunnel', 'findTunnelsByName']);
});

test('createCname ผลไม่แน่ชัด: record ที่ content ตรงของเราแต่ไม่ใช่ CNAME (TXT/A) ไม่ถูกรับมาลบ', async () => {
  const { service, calls } = harness({
    failAt: { createCname: timeoutErr },
    findRecords: [{ id: REC, type: 'TXT', name: 'shop.example.com', content: `${TID}.cfargotunnel.com` }],
  });
  await service.provision('shop', PLAN);
  assert.ok(!calls.includes('deleteDnsRecord'));
});

test('scrub ด้วยการเทียบค่าตรงๆ: token สั้นกว่า 24 ตัว (regex ทั่วไปจับไม่ได้) จาก createTunnel และจาก getTunnelToken ไม่รั่วในผลลัพธ์/log/orphan', async () => {
  for (const fromCreate of [true, false]) {
    reset();
    const short = 'shorttok_12345';
    const h = harness({ tokenValue: short, tokenFromCreate: fromCreate, leak: true, failAt: { startTunnelContainer: new Error('docker boom'), deleteTunnel: new Error('x') } });
    const result = await h.service.provision('shop', PLAN);
    const sweep = [JSON.stringify(result), h.logs.join('\n'), fs.readFileSync(orphansFile(), 'utf8')].join('\n');
    assert.equal(result.status, 'failed');
    assert.ok(!sweep.includes(short), `fromCreate=${fromCreate}`);
  }
});

test('ข้อความ error ที่ยาวมากถูกตัดก่อนออกไปในผลลัพธ์/log', async () => {
  const { service } = harness({ failAt: { putIngress: () => new CloudflareError(`cloudflare putIngress: ${'word '.repeat(500)}`, { op: 'putIngress', code: 'http', status: 400 }) } });
  const result = await service.provision('shop', PLAN);
  assert.ok(result.message.length <= 301, String(result.message.length));
});

test('log ตอน provision สำเร็จ ไม่อ้างว่า tunnel "พร้อม/ออนไลน์" — บอกว่าสร้างแล้วและยังไม่ตรวจการเชื่อมต่อ', async () => {
  const { service, logs } = harness();
  await service.provision('shop', PLAN);
  const line = logs.find((l) => /shop/.test(l) && /tunnel/i.test(l));
  assert.ok(line, logs.join('\n'));
  assert.match(line, /not verified/);
  assert.doesNotMatch(line, /\bready\b|online/i);
});

test('token จริงรูปแบบ Cloudflare (240 ตัว, base64 มี + / =): ไม่รั่วแม้เป็นบางช่วง ทั้งผลลัพธ์/log/orphan เมื่อ error มี token ปน (ทั้งทาง create และ getTunnelToken)', async () => {
  const { TUNNEL_TOKEN_240 } = require('./fixtures/cloudflare-live-2026-10-20');
  for (const fromCreate of [true, false]) {
    reset();
    const h = harness({ tokenValue: TUNNEL_TOKEN_240, tokenFromCreate: fromCreate, leak: true, failAt: { startTunnelContainer: new Error('docker boom'), deleteTunnel: new Error('x') } });
    const result = await h.service.provision('shop', PLAN);
    assert.equal(result.status, 'failed');
    const sweep = [JSON.stringify(result), h.logs.join('\n'), fs.readFileSync(orphansFile(), 'utf8')].join('\n');
    // ไม่มีช่วงใดของ token ยาว 30 ตัวโผล่ (ตรวจทุกช่วง ไม่ใช่แค่ทั้งก้อน)
    for (let i = 0; i + 30 <= TUNNEL_TOKEN_240.length; i += 5) {
      assert.ok(!sweep.includes(TUNNEL_TOKEN_240.slice(i, i + 30)), `fromCreate=${fromCreate} offset ${i}`);
    }
  }
});
