// ล้าง Cloudflare ตอนลบบอท + จัดการรายการค้าง (services/cloudflare-auto.js: teardown / recordKept / cleanupOrphan / listOrphans)
// ฉีด client/ops จำลองทั้งหมด — ไม่เรียก Cloudflare/Docker จริง และไม่ใช้ token จริง
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cftear-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(path.join(process.env.BOTS_ROOT, 'shop'), { recursive: true });

const realState = require('../services/cloudflare-state');
const { createAutoTunnelService } = require('../services/cloudflare-auto');
const { ACCT, ZONE, TID, TID2, REC, TOKEN, SETTINGS, http, makeFakes } = require('./helpers/cloudflare-fakes');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const orphansFile = () => path.join(path.dirname(process.env.DB_PATH), 'cf-orphans.json');
const stateFile = () => path.join(process.env.BOTS_ROOT, 'shop', 'cloudflare.json');
test.beforeEach(() => {
  fs.rmSync(stateFile(), { force: true });
  fs.rmSync(orphansFile(), { force: true });
});

function build(opts = {}, settings = SETTINGS) {
  const fakes = makeFakes(opts);
  const service = createAutoTunnelService({ settings, client: fakes.client, state: realState, ops: fakes.ops, logger: fakes.logger });
  return { ...fakes, service };
}

const seedState = (over = {}) => realState.writeState('shop', {
  accountId: ACCT, zoneId: ZONE, tunnelId: TID, hostname: 'shop.example.com', dnsRecordId: REC, step: 'complete', ...over,
});
const seedOrphan = (over = {}) => realState.addOrphan({
  botName: 'shop', hostname: 'shop.example.com', tunnelId: TID, dnsRecordId: REC, accountId: ACCT, zoneId: ZONE,
  reason: 'earlier failure', leftovers: ['dns', 'tunnel'], ...over,
});

const ROLLBACK = [
  ['container', 'removeTunnelContainer'],
  ['dns', 'deleteDnsRecord'],
  ['tunnel', 'deleteTunnel'],
  ['env-token', 'clearEnvToken'],
];

// ── teardown (ลบบอท) ─────────────────────────────────────────────────────────
test('teardown: บอทที่ไม่มี state → {status:"none"} ไม่แตะอะไร', async () => {
  const { service, calls } = build();
  assert.deepEqual(await service.teardown('shop', { reason: 'bot removal' }), { status: 'none' });
  assert.deepEqual(calls, []);
});

test('teardown สำเร็จ: container → DNS → tunnel → token ใน .env ตามลำดับ (พร้อม guard) แล้วลบ state; ไม่มี orphan', async () => {
  seedState();
  const { service, calls, callArgs } = build();
  const result = await service.teardown('shop', { reason: 'bot removal' });
  assert.deepEqual(result, { status: 'removed', rollback: { ok: true, failed: [], orphaned: false } });
  assert.deepEqual(calls, ['removeTunnelContainer', 'deleteDnsRecord', 'deleteTunnel', 'clearEnvToken']);
  assert.deepEqual(callArgs.deleteDnsRecord[0], [REC, { hostname: 'shop.example.com', tunnelId: TID }]);
  assert.deepEqual(callArgs.deleteTunnel[0], [TID, { expectedName: 'netguard-shop' }]);
  assert.equal(fs.existsSync(stateFile()), false);
  assert.equal(fs.existsSync(orphansFile()), false);
});

test('teardown: state ที่ยังไม่มี DNS record id → ข้ามขั้น DNS', async () => {
  seedState({ dnsRecordId: null, step: 'ingress-set' });
  const { service, calls } = build();
  assert.equal((await service.teardown('shop', { reason: 'x' })).status, 'removed');
  assert.deepEqual(calls, ['removeTunnelContainer', 'deleteTunnel', 'clearEnvToken']);
});

for (let mask = 1; mask < 16; mask++) {
  const failing = ROLLBACK.filter((_, i) => mask & (1 << i));
  test(`teardown ล้มชุด [${failing.map((f) => f[0]).join(', ')}]: ลองครบทุกขั้น, ลง orphan ตรงกับที่ล้ม, ไม่หยุด, ไม่เงียบ`, async () => {
    seedState();
    const failAt = {};
    for (const [, method] of failing) failAt[method] = new Error(`${method} exploded`);
    const { service, calls, logs } = build({ failAt });
    const result = await service.teardown('shop', { reason: 'bot removal' });
    assert.deepEqual(calls, ROLLBACK.map((r) => r[1]));
    const names = failing.map((f) => f[0]);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.rollback, { ok: false, failed: names, orphaned: true });
    const [orphan] = realState.listOrphans();
    assert.deepEqual(orphan.leftovers, names);
    assert.equal(orphan.dnsRecordId, names.includes('dns') ? REC : null);
    assert.equal(orphan.tunnelId, TID);
    assert.equal(fs.existsSync(stateFile()), false);
    for (const name of names) assert.ok(logs.some((l) => l.includes(name) && l.includes('shop')), name);
  });
}

test('teardown: deleteTunnel ปฏิเสธเพราะชื่อไม่ตรง (state ถูกแก้ชี้ tunnel อื่น) → นับเป็นขั้น tunnel ที่ล้ม + orphan; ไม่ลบ tunnel อื่น', async () => {
  seedState({ tunnelId: TID2 });
  const refusal = Object.assign(new Error('refusing to delete'), { name: 'CloudflareError', code: 'not-owned' });
  const { service, callArgs } = build({ failAt: { deleteTunnel: refusal } });
  const result = await service.teardown('shop', { reason: 'bot removal' });
  assert.deepEqual(result.rollback.failed, ['tunnel']);
  assert.deepEqual(callArgs.deleteTunnel[0], [TID2, { expectedName: 'netguard-shop' }]);
});

test('teardown: state ของ account/zone อื่นจากที่ตั้งไว้ → ปฏิเสธ 409 ไม่แตะอะไร และเก็บ state ไว้', async () => {
  seedState({ accountId: 'ffffffffffffffffffffffffffffffff' });
  const { service, calls } = build();
  await assert.rejects(service.teardown('shop', { reason: 'x' }), (e) => e.statusCode === 409 && e.code === 'account-mismatch');
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(stateFile()), true);
  fs.rmSync(stateFile());
  seedState({ zoneId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
  await assert.rejects(service.teardown('shop', { reason: 'x' }), (e) => e.code === 'account-mismatch');
});

test('teardown: flag ปิด → 403 ไม่แตะ client/ops/state', async () => {
  seedState();
  const { service, calls } = build({}, { ...SETTINGS, enabled: false });
  await assert.rejects(service.teardown('shop', { reason: 'x' }), (e) => e.statusCode === 403 && e.code === 'disabled');
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(stateFile()), true);
});

test('teardown: state เสีย → โยน corrupt ไม่ลบอะไรมั่ว', async () => {
  fs.writeFileSync(stateFile(), '{broken');
  const { service, calls } = build();
  await assert.rejects(service.teardown('shop', { reason: 'x' }), (e) => e.code === 'corrupt');
  assert.deepEqual(calls, []);
});

test('teardown: ลง orphan ไม่ได้ → เก็บ state ไว้ + รายงาน orphaned=false', async () => {
  seedState();
  fs.mkdirSync(path.dirname(orphansFile()), { recursive: true });
  fs.writeFileSync(orphansFile(), '{broken');
  const { service } = build({ failAt: { deleteTunnel: new Error('nope') } });
  const result = await service.teardown('shop', { reason: 'x' });
  assert.equal(result.status, 'partial');
  assert.equal(result.rollback.orphaned, false);
  assert.equal(fs.existsSync(stateFile()), true);
});

test('teardown: error ที่มีสตริงหน้าตาเป็น token ปนมา ไม่โผล่ใน log/orphan/ผลลัพธ์', async () => {
  seedState();
  const { service, logs } = build({ failAt: { deleteDnsRecord: new Error('x'), deleteTunnel: new Error('y'), clearEnvToken: new Error('z'), removeTunnelContainer: new Error('w') }, leak: true });
  const result = await service.teardown('shop', { reason: 'x' });
  const sweep = [JSON.stringify(result), logs.join('\n'), fs.readFileSync(orphansFile(), 'utf8')].join('\n');
  assert.ok(!sweep.includes(TOKEN));
});

// ── recordKept: ลบบอทโดยไม่ลบ Cloudflare แต่ต้องไม่ทำให้ของหายเงียบๆ ───────────────────
test('recordKept: ลง orphan (dns+tunnel ถ้ามี DNS id, ไม่งั้น tunnel) แล้วลบ state; ไม่ต้องใช้ client และใช้ได้แม้ flag ปิด', () => {
  seedState();
  const off = build({}, { ...SETTINGS, enabled: false });
  const r = off.service.recordKept('shop');
  assert.deepEqual(r, { recorded: true });
  const [o] = realState.listOrphans();
  assert.deepEqual(o.leftovers, ['dns', 'tunnel']);
  assert.equal(o.dnsRecordId, REC);
  assert.match(o.reason, /kept/i);
  assert.equal(fs.existsSync(stateFile()), false);
  assert.deepEqual(off.calls, []);

  fs.rmSync(orphansFile());
  seedState({ dnsRecordId: null, step: 'ingress-set' });
  off.service.recordKept('shop');
  assert.deepEqual(realState.listOrphans()[0].leftovers, ['tunnel']);
  assert.equal(realState.listOrphans()[0].dnsRecordId, null);
});

test('recordKept: ไม่มี state → {recorded:false}; ลง orphan ไม่ได้ → โยน error และไม่ลบ state', () => {
  const { service } = build();
  assert.deepEqual(service.recordKept('shop'), { recorded: false });
  seedState();
  fs.mkdirSync(path.dirname(orphansFile()), { recursive: true });
  fs.writeFileSync(orphansFile(), '{broken');
  assert.throws(() => service.recordKept('shop'), (e) => e.code === 'corrupt');
  assert.equal(fs.existsSync(stateFile()), true);
});

// ── cleanupOrphan ───────────────────────────────────────────────────────────
test('cleanupOrphan: ทำเฉพาะขั้นที่ค้าง (dns, tunnel) ตามลำดับพร้อม guard แล้วลบรายการ', async () => {
  seedOrphan();
  const { service, calls, callArgs } = build();
  const result = await service.cleanupOrphan(TID);
  assert.deepEqual(result, { status: 'cleaned', failed: [] });
  assert.deepEqual(calls, ['deleteDnsRecord', 'deleteTunnel']);
  assert.deepEqual(callArgs.deleteDnsRecord[0], [REC, { hostname: 'shop.example.com', tunnelId: TID }]);
  assert.deepEqual(callArgs.deleteTunnel[0], [TID, { expectedName: 'netguard-shop' }]);
  assert.deepEqual(realState.listOrphans(), []);
});

test('cleanupOrphan: ขั้น container/env-token ใช้ ops ไม่แตะ Cloudflare', async () => {
  seedOrphan({ dnsRecordId: null, leftovers: ['container', 'env-token'] });
  const { service, calls } = build();
  assert.equal((await service.cleanupOrphan(TID)).status, 'cleaned');
  assert.deepEqual(calls, ['removeTunnelContainer', 'clearEnvToken']);
});

test('cleanupOrphan: ล้มบางขั้น → ลองครบ แล้วอัปเดตรายการให้เหลือเฉพาะที่ยังค้าง (status partial)', async () => {
  seedOrphan({ leftovers: ['container', 'dns', 'tunnel', 'env-token'] });
  const { service, calls } = build({ failAt: { deleteTunnel: http(500), removeTunnelContainer: new Error('busy') } });
  const result = await service.cleanupOrphan(TID);
  assert.deepEqual(result, { status: 'partial', failed: ['container', 'tunnel'] });
  assert.deepEqual(calls, ['removeTunnelContainer', 'deleteDnsRecord', 'deleteTunnel', 'clearEnvToken']);
  const [o] = realState.listOrphans();
  assert.deepEqual(o.leftovers, ['container', 'tunnel']);
  assert.equal(o.dnsRecordId, null); // DNS ลบแล้ว
});

test('cleanupOrphan: ขั้น dns ที่ไม่มี DNS record id ถือว่าไม่มีอะไรต้องลบ (ไม่เรียก client)', async () => {
  seedOrphan({ dnsRecordId: null, leftovers: ['dns', 'tunnel'] });
  const { service, calls } = build();
  assert.equal((await service.cleanupOrphan(TID)).status, 'cleaned');
  assert.deepEqual(calls, ['deleteTunnel']);
});

test('cleanupOrphan: รายการเก่าที่ไม่มี leftovers → ลองทุกขั้น (dns เฉพาะที่มี id)', async () => {
  realState.addOrphan({ botName: 'shop', hostname: 'shop.example.com', tunnelId: TID, dnsRecordId: REC, accountId: ACCT, zoneId: ZONE, reason: 'legacy entry' }); // ไม่มี leftovers
  const { service, calls } = build();
  assert.equal((await service.cleanupOrphan(TID)).status, 'cleaned');
  assert.deepEqual(calls, ['removeTunnelContainer', 'deleteDnsRecord', 'deleteTunnel', 'clearEnvToken']);
});

test('cleanupOrphan: ไม่พบรายการ → 404 not-found; flag ปิด → 403; account ไม่ตรง → 409 ไม่แตะอะไร', async () => {
  const { service, calls } = build();
  await assert.rejects(service.cleanupOrphan(TID), (e) => e.statusCode === 404 && e.code === 'not-found');
  await assert.rejects(service.cleanupOrphan('not-a-uuid'), (e) => e.statusCode === 400);

  seedOrphan();
  const off = build({}, { ...SETTINGS, enabled: false });
  await assert.rejects(off.service.cleanupOrphan(TID), (e) => e.statusCode === 403 && e.code === 'disabled');
  assert.deepEqual(off.calls, []);

  fs.rmSync(orphansFile());
  seedOrphan({ accountId: 'ffffffffffffffffffffffffffffffff' });
  await assert.rejects(service.cleanupOrphan(TID), (e) => e.statusCode === 409 && e.code === 'account-mismatch');
  assert.deepEqual(calls, []);
  assert.equal(realState.listOrphans().length, 1);
});

test('listOrphans: คืนรายการค้าง (ไม่มีความลับ) ใช้ได้แม้ flag ปิด', () => {
  seedOrphan();
  const { service } = build({}, { ...SETTINGS, enabled: false });
  const list = service.listOrphans();
  assert.equal(list.length, 1);
  assert.equal(list[0].tunnelId, TID);
  assert.ok(!/token/i.test(JSON.stringify(list)));
});
