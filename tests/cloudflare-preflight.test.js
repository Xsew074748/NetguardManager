// กฎ hostname + preflight (อ่านอย่างเดียว) ก่อนสร้าง tunnel อัตโนมัติ — services/cloudflare-preflight.js
// ไม่เรียก Cloudflare จริง: client จำลองมีเฉพาะเมธอด find* (ถ้าโค้ดเรียกเมธอดที่สร้าง/ลบ จะ TypeError ทันที = พิสูจน์ว่าอ่านอย่างเดียว)
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfpre-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const { CloudflareError } = require('../services/cloudflare');
const realState = require('../services/cloudflare-state');
const pre = require('../services/cloudflare-preflight');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ZONE = 'example.com';
const TID = '11111111-2222-4333-8444-555555555555';
const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE_ID = 'fedcba9876543210fedcba9876543210';

const isPreflight = (status, code) => (e) => e instanceof pre.PreflightError && e.statusCode === status && e.code === code;

// ── กฎ hostname ───────────────────────────────────────────────────────────────
test('validateAutoHostname: รับ <label>.<zone> และ normalize เป็นตัวพิมพ์เล็ก/ตัดช่องว่างหัวท้าย', () => {
  assert.equal(pre.validateAutoHostname('shop.example.com', { zoneName: ZONE }), 'shop.example.com');
  assert.equal(pre.validateAutoHostname('  Shop.Example.COM ', { zoneName: ZONE }), 'shop.example.com');
  assert.equal(pre.validateAutoHostname('acme-01.example.com', { zoneName: ZONE }), 'acme-01.example.com');
});

test('validateAutoHostname: ปฏิเสธรูปแบบที่ผิด (400 invalid-hostname)', () => {
  const bad = [
    '', ' ', undefined, null, 42, {},
    'example.com', // apex
    'a.b.example.com', // ลึกเกิน 1 label
    'shop.other.com', // คนละ zone
    'shop.notexample.com', // suffix หลอก
    'shopexample.com',
    'shop.example.com.evil.net',
    '.example.com',
    'shop.example.com.', // จุดท้าย
    '*.example.com', 'sh*p.example.com',
    'sh op.example.com', 'shop@.example.com', 'sh_op.example.com',
    'ชื่อ.example.com',
    '-shop.example.com', 'shop-.example.com',
    `${'a'.repeat(64)}.example.com`,
    'xn--shop-abc.example.com', // IDN/punycode ไม่รับ (กัน homograph)
    'shop.example.com\n', 'shop.example.com\r\nx',
    'http://shop.example.com', 'shop.example.com/path', 'shop.example.com:443',
  ];
  for (const b of bad) {
    assert.throws(() => pre.validateAutoHostname(b, { zoneName: ZONE }), isPreflight(400, 'invalid-hostname'), JSON.stringify(b));
  }
});

test('validateAutoHostname: ชื่อสงวนเริ่มต้น (www, bot, ...) และของที่ตั้งเพิ่ม (label หรือ hostname เต็ม) ถูกปฏิเสธ 400 reserved-hostname', () => {
  for (const label of ['www', 'bot', 'WWW', 'mail', 'admin', 'api', 'manager']) {
    assert.throws(() => pre.validateAutoHostname(`${label}.example.com`, { zoneName: ZONE }), isPreflight(400, 'reserved-hostname'), label);
  }
  assert.throws(() => pre.validateAutoHostname('vip.example.com', { zoneName: ZONE, reserved: ['vip'] }), isPreflight(400, 'reserved-hostname'));
  assert.throws(() => pre.validateAutoHostname('Prod.example.com', { zoneName: ZONE, reserved: ['prod.example.com'] }), isPreflight(400, 'reserved-hostname'));
  assert.equal(pre.validateAutoHostname('shop.example.com', { zoneName: ZONE, reserved: ['vip', 'prod.example.com'] }), 'shop.example.com');
  // รายการสงวนที่ตั้งเป็นตัวพิมพ์ใหญ่ก็ต้องกันได้ (เทียบแบบไม่สนตัวพิมพ์)
  assert.throws(() => pre.validateAutoHostname('vip.example.com', { zoneName: ZONE, reserved: ['VIP'] }), isPreflight(400, 'reserved-hostname'));
  assert.throws(() => pre.validateAutoHostname('prod.example.com', { zoneName: ZONE, reserved: ['Prod.Example.COM'] }), isPreflight(400, 'reserved-hostname'));
});

test('validateAutoHostname: zoneName ที่ตั้งไว้ผิดรูปแบบ → ล้ม (fail closed) ไม่เดาเอง', () => {
  for (const zoneName of ['', undefined, 'Example.com', 'example', 'exa mple.com', 'example.com.']) {
    assert.throws(() => pre.validateAutoHostname('shop.example.com', { zoneName }), isPreflight(500, 'bad-config'), String(zoneName));
  }
  assert.throws(() => pre.validateAutoHostname('shop.example.com', { zoneName: ZONE, reserved: 'www' }), isPreflight(500, 'bad-config'));
});

// ── preflight ────────────────────────────────────────────────────────────────
function fakeClient({ records = [], tunnels = [], recordsError, tunnelsError } = {}) {
  const calls = [];
  return {
    calls,
    async findDnsRecords(host) {
      calls.push(['findDnsRecords', host]);
      if (recordsError) throw recordsError;
      return records;
    },
    async findTunnelsByName(name) {
      calls.push(['findTunnelsByName', name]);
      if (tunnelsError) throw tunnelsError;
      return tunnels;
    },
  };
}

function fakeState({ states = [], orphans = [], readState = null, listStatesError } = {}) {
  return {
    readState: () => readState,
    listStates: () => { if (listStatesError) throw listStatesError; return states; },
    listOrphans: () => orphans,
  };
}

const run = (over = {}) => pre.preflightAutoTunnel({
  client: fakeClient(), state: fakeState(), botName: 'shop', hostname: 'shop.example.com', zoneName: ZONE, ...over,
});

test('preflight ผ่าน: คืนชื่อ tunnel/hostname/service ที่จะใช้ และยิงเฉพาะคำขออ่าน (DNS ตามชื่อ + tunnel ตามชื่อ)', async () => {
  const client = fakeClient();
  const plan = await run({ client, hostname: ' Shop.example.com ' });
  assert.deepEqual(plan, { hostname: 'shop.example.com', tunnelName: 'netguard-shop', service: 'http://netguard-shop:3000' });
  assert.deepEqual(client.calls, [['findDnsRecords', 'shop.example.com'], ['findTunnelsByName', 'netguard-shop']]);
});

test('preflight: ชื่อบอทผิดรูปแบบ → 400 และไม่ยิงอะไร', async () => {
  for (const botName of ['', '../x', 'A', 'x', undefined, 'a'.repeat(40)]) {
    const client = fakeClient();
    await assert.rejects(run({ client, botName }), isPreflight(400, 'invalid-bot-name'), String(botName));
    assert.equal(client.calls.length, 0);
  }
});

test('preflight: hostname ผิดกฎ → 400 และไม่ยิงอะไร', async () => {
  const client = fakeClient();
  await assert.rejects(run({ client, hostname: 'www.example.com' }), isPreflight(400, 'reserved-hostname'));
  await assert.rejects(run({ client, hostname: 'a.b.example.com' }), isPreflight(400, 'invalid-hostname'));
  assert.equal(client.calls.length, 0);
});

test('preflight: บอทนี้มี state อยู่แล้ว → 409 state-exists (ไม่ยิงอะไร — ทำซ้ำต้องไปทางลองใหม่ ไม่ใช่สร้างใหม่)', async () => {
  const client = fakeClient();
  await assert.rejects(run({ client, state: fakeState({ readState: { tunnelId: TID, hostname: 'shop.example.com' } }) }), isPreflight(409, 'state-exists'));
  assert.equal(client.calls.length, 0);
});

test('preflight: hostname ซ้ำกับบอทอื่นที่มี state → 409 hostname-in-use (ไม่ยิงอะไร)', async () => {
  const client = fakeClient();
  const states = [{ botName: 'other', state: { hostname: 'shop.example.com', tunnelId: TID } }];
  await assert.rejects(run({ client, state: fakeState({ states }) }), isPreflight(409, 'hostname-in-use'));
  assert.equal(client.calls.length, 0);
});

test('preflight: มีรายการค้างของ hostname หรือชื่อบอทเดียวกัน → 409 orphan-exists (ต้องล้างของค้างก่อน)', async () => {
  const byHost = [{ botName: 'old', hostname: 'shop.example.com', tunnelId: TID }];
  const byBot = [{ botName: 'shop', hostname: 'old.example.com', tunnelId: TID }];
  for (const orphans of [byHost, byBot]) {
    const client = fakeClient();
    await assert.rejects(run({ client, state: fakeState({ orphans }) }), isPreflight(409, 'orphan-exists'));
    assert.equal(client.calls.length, 0);
  }
});

test('preflight: ใน Cloudflare มี DNS record ชื่อนี้อยู่แล้ว (ชนิดใดก็ได้) → 409 hostname-in-use ข้อความบอกชนิดแต่ไม่โชว์ content และไม่ตรวจต่อ', async () => {
  for (const type of ['CNAME', 'A', 'TXT']) {
    const client = fakeClient({ records: [{ id: 'r1', type, name: 'shop.example.com', content: 'secret-looking-content-1234567890abcdef' }] });
    await assert.rejects(run({ client }), (e) => {
      assert.ok(isPreflight(409, 'hostname-in-use')(e));
      assert.match(e.message, new RegExp(type));
      assert.ok(!e.message.includes('secret-looking'));
      return true;
    });
    assert.deepEqual(client.calls.map((c) => c[0]), ['findDnsRecords']);
  }
});

test('preflight: มี tunnel ชื่อ netguard-<บอท> อยู่แล้ว → 409 tunnel-exists', async () => {
  const client = fakeClient({ tunnels: [{ id: TID, name: 'netguard-shop' }] });
  await assert.rejects(run({ client }), isPreflight(409, 'tunnel-exists'));
  assert.deepEqual(client.calls.map((c) => c[0]), ['findDnsRecords', 'findTunnelsByName']);
});

test('preflight: ตรวจ Cloudflare ไม่ได้ (error ใดๆ ของ client) → 502 cloudflare-check-failed — ไม่ถือว่า "ว่าง"', async () => {
  const err = new CloudflareError('cloudflare findDnsRecords: HTTP 403', { op: 'findDnsRecords', code: 'http', status: 403 });
  await assert.rejects(run({ client: fakeClient({ recordsError: err }) }), isPreflight(502, 'cloudflare-check-failed'));
  const tErr = new CloudflareError('cloudflare findTunnelsByName: timed out', { op: 'findTunnelsByName', code: 'timeout' });
  await assert.rejects(run({ client: fakeClient({ tunnelsError: tErr }) }), isPreflight(502, 'cloudflare-check-failed'));
  const noToken = new CloudflareError('cloudflare findDnsRecords: API token is not available', { op: 'findDnsRecords', code: 'no-token' });
  await assert.rejects(run({ client: fakeClient({ recordsError: noToken }) }), isPreflight(502, 'cloudflare-check-failed'));
});

test('preflight: error ที่ไม่ใช่ของ Cloudflare (บั๊ก) ไม่ถูกกลืน — โยนต่อ', async () => {
  await assert.rejects(run({ client: fakeClient({ recordsError: new TypeError('bug') }) }), TypeError);
});

test('preflight: อ่าน state/orphans ไม่ได้ (ไฟล์เสีย) → 500 state-unreadable และไม่ยิงอะไร (fail closed)', async () => {
  const client = fakeClient();
  const corrupt = new realState.CloudflareStateError('cloudflare.json is corrupt', 'corrupt');
  await assert.rejects(run({ client, state: fakeState({ listStatesError: corrupt }) }), isPreflight(500, 'state-unreadable'));
  const readErr = { ...fakeState(), readState: () => { throw corrupt; } };
  await assert.rejects(run({ client, state: readErr }), isPreflight(500, 'state-unreadable'));
  const orphErr = { ...fakeState(), listOrphans: () => { throw corrupt; } };
  await assert.rejects(run({ client, state: orphErr }), isPreflight(500, 'state-unreadable'));
  assert.equal(client.calls.length, 0);
});

test('preflight: ค่าเริ่มต้นของ state ใช้ cloudflare-state จริง — บอทอื่นมี hostname เดียวกันบนดิสก์ → 409', async () => {
  realState.writeState('otherbot', { accountId: ACCT, zoneId: ZONE_ID, tunnelId: TID, hostname: 'shop.example.com', dnsRecordId: null, step: 'complete' });
  const client = fakeClient();
  await assert.rejects(pre.preflightAutoTunnel({ client, botName: 'shop', hostname: 'shop.example.com', zoneName: ZONE }), isPreflight(409, 'hostname-in-use'));
  assert.equal(client.calls.length, 0);
  // hostname อื่นผ่าน
  const plan = await pre.preflightAutoTunnel({ client, botName: 'shop', hostname: 'fresh.example.com', zoneName: ZONE });
  assert.equal(plan.hostname, 'fresh.example.com');
  // state เสียของบอทอื่น → ล้ม ไม่ข้าม
  fs.writeFileSync(path.join(process.env.BOTS_ROOT, 'otherbot', 'cloudflare.json'), '{broken');
  await assert.rejects(pre.preflightAutoTunnel({ client, botName: 'shop', hostname: 'fresh.example.com', zoneName: ZONE }), isPreflight(500, 'state-unreadable'));
});

test('preflight: ไม่มี client/zoneName → ล้มทันที (bad-config)', async () => {
  await assert.rejects(pre.preflightAutoTunnel({ state: fakeState(), botName: 'shop', hostname: 'shop.example.com', zoneName: ZONE }), isPreflight(500, 'bad-config'));
});

test('preflight: client ที่มีเมธอดไม่ครบ (ขาดอันใดอันหนึ่ง) → bad-config', async () => {
  const full = fakeClient();
  await assert.rejects(run({ client: { findTunnelsByName: full.findTunnelsByName } }), isPreflight(500, 'bad-config'));
  await assert.rejects(run({ client: { findDnsRecords: full.findDnsRecords } }), isPreflight(500, 'bad-config'));
});
