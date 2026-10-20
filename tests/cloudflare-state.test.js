// state ของ Cloudflare ต่อบอท (bots/<name>/cloudflare.json) และรายการค้าง (cf-orphans.json) — services/cloudflare-state.js
// ต้อง: ไม่มี token/ความลับ, เขียนแบบ atomic สิทธิ์ 0600, ตรวจค่าก่อนเขียน, ไฟล์เสียต้อง "ล้ม" ไม่ใช่ถือว่าไม่มี state
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfstate-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const state = require('../services/cloudflare-state');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '11111111-2222-4333-8444-555555555555';
const TID2 = '22222222-2222-4333-8444-555555555555';
const REC = 'abcdef0123456789abcdef0123456789';

const valid = (over = {}) => ({
  accountId: ACCT, zoneId: ZONE, tunnelId: TID, hostname: 'shop.example.com', dnsRecordId: null, step: 'tunnel-created', ...over,
});
const stateFile = (name) => path.join(process.env.BOTS_ROOT, name, 'cloudflare.json');
const orphansFile = () => path.join(path.dirname(process.env.DB_PATH), 'cf-orphans.json');

// จับการเขียนไฟล์ — ตรวจ mode 0600 และลำดับ tmp→rename ได้แม้บน Windows ที่ chmod ไม่มีผล
function spyFs(fn) {
  const writes = [];
  const renames = [];
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  fs.writeFileSync = function (file, data, opts) {
    writes.push({ file: String(file), data: String(data), opts });
    return origWrite.apply(this, arguments);
  };
  fs.renameSync = function (from, to) {
    renames.push({ from: String(from), to: String(to) });
    return origRename.apply(this, arguments);
  };
  try {
    fn({ writes, renames });
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
  }
}

test('readState: ไม่มีไฟล์ → null', () => {
  assert.equal(state.readState('nofile'), null);
});

test('writeState/readState: เก็บครบ มี version, createdAt, updatedAt', () => {
  const before = Date.now();
  state.writeState('shop', valid());
  const s = state.readState('shop');
  assert.equal(s.version, 1);
  assert.equal(s.accountId, ACCT);
  assert.equal(s.zoneId, ZONE);
  assert.equal(s.tunnelId, TID);
  assert.equal(s.hostname, 'shop.example.com');
  assert.equal(s.dnsRecordId, null);
  assert.equal(s.step, 'tunnel-created');
  assert.ok(Date.parse(s.createdAt) >= before - 1000);
  assert.ok(Date.parse(s.updatedAt) >= before - 1000);
  assert.equal(fs.existsSync(stateFile('shop')), true);
});

test('writeState: สิทธิ์ไฟล์ 0600, เขียน tmp ก่อนแล้ว rename ทับ, ไม่ทิ้งไฟล์ tmp', () => {
  spyFs(({ writes, renames }) => {
    state.writeState('perm', valid());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].opts.mode, 0o600);
    assert.notEqual(writes[0].file, stateFile('perm'));
    assert.deepEqual(renames, [{ from: writes[0].file, to: stateFile('perm') }]);
  });
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile('perm'))).filter((f) => f.includes('.tmp')), []);
});

test('writeState: rename ล้ม → ไฟล์เดิมไม่เสีย, tmp ถูกลบ, error ถูกโยนต่อ', () => {
  state.writeState('atomic', valid({ step: 'tunnel-created' }));
  const original = fs.readFileSync(stateFile('atomic'), 'utf8');
  const origRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => state.writeState('atomic', valid({ step: 'ingress-set' })), /disk full/);
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(fs.readFileSync(stateFile('atomic'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile('atomic'))).filter((f) => f.includes('.tmp')), []);
});

test('writeState: เขียนทับแล้วคง createdAt เดิม แต่ updatedAt ใหม่', async () => {
  state.writeState('keep', valid());
  const first = state.readState('keep');
  await new Promise((r) => setTimeout(r, 5));
  state.writeState('keep', valid({ step: 'ingress-set' }));
  const second = state.readState('keep');
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
  assert.equal(second.step, 'ingress-set');
});

test('writeState: ปฏิเสธ key ที่ไม่อยู่ใน whitelist โดยเฉพาะชื่อเกี่ยวกับ token/secret (ไม่เงียบตัดทิ้ง) และไม่เขียนไฟล์', () => {
  for (const key of ['token', 'tunnelToken', 'apiToken', 'secret', 'password', 'authorization', 'extra']) {
    assert.throws(() => state.writeState('bad', valid({ [key]: 'x'.repeat(40) })), /field|key|ไม่รองรับ/i, key);
  }
  assert.equal(fs.existsSync(stateFile('bad')), false);
});

test('writeState: ตรวจค่า — hostname/ID/step/ชื่อบอทผิดรูปแบบถูกปฏิเสธ (รวม path traversal)', () => {
  const cases = [
    valid({ hostname: 'UPPER.example.com' }),
    valid({ hostname: 'a b.example.com' }),
    valid({ hostname: '*.example.com' }),
    valid({ tunnelId: 'not-a-uuid' }),
    valid({ accountId: 'a/b' }),
    valid({ zoneId: '' }),
    valid({ dnsRecordId: '../x' }),
    valid({ step: 'hacked' }),
    valid({ tunnelId: undefined }),
    (() => { const { tunnelId, ...rest } = valid(); return rest; })(), // ไม่มี key นี้เลย
    (() => { const { hostname, ...rest } = valid(); return rest; })(),
    (() => { const { step, ...rest } = valid(); return rest; })(),
  ];
  for (const c of cases) assert.throws(() => state.writeState('okname', c), CloudflareStateErrorLike, JSON.stringify(c));
  for (const name of ['../evil', 'a/b', '', 'A', 'x', '.hidden', 'a'.repeat(40)]) {
    assert.throws(() => state.writeState(name, valid()), CloudflareStateErrorLike, `name=${name}`);
    assert.throws(() => state.readState(name), CloudflareStateErrorLike, `read name=${name}`);
  }
  assert.equal(fs.existsSync(path.join(process.env.BOTS_ROOT, '..', 'evil')), false);
});

function CloudflareStateErrorLike(e) {
  return e instanceof Error && e.name === 'CloudflareStateError';
}

test('ไฟล์ state ไม่มีคำว่า token หรือค่าที่หน้าตาเป็นความลับ', () => {
  state.writeState('clean', valid({ dnsRecordId: REC, step: 'complete' }));
  const raw = fs.readFileSync(stateFile('clean'), 'utf8');
  assert.ok(!/token|secret|password|authorization/i.test(raw));
});

test('updateState: รวมฟิลด์ใหม่เข้ากับของเดิม, คง createdAt; ไม่มี state → error', () => {
  state.writeState('upd', valid());
  const before = state.readState('upd');
  const after = state.updateState('upd', { dnsRecordId: REC, step: 'dns-created' });
  assert.equal(after.dnsRecordId, REC);
  assert.equal(after.step, 'dns-created');
  assert.equal(after.tunnelId, TID);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(state.readState('upd'), after);
  assert.throws(() => state.updateState('absent', { step: 'complete' }), (e) => CloudflareStateErrorLike(e) && e.code === 'missing');
});

test('updateState: patch ที่มี key ต้องห้าม/ค่าผิด ถูกปฏิเสธและไฟล์เดิมไม่เปลี่ยน', () => {
  state.writeState('upd2', valid());
  const raw = fs.readFileSync(stateFile('upd2'), 'utf8');
  assert.throws(() => state.updateState('upd2', { token: 'x'.repeat(40) }), CloudflareStateErrorLike);
  assert.throws(() => state.updateState('upd2', { step: 'nope' }), CloudflareStateErrorLike);
  assert.throws(() => state.updateState('upd2', { tunnelId: TID2 }), CloudflareStateErrorLike); // tunnelId เปลี่ยนไม่ได้
  assert.equal(fs.readFileSync(stateFile('upd2'), 'utf8'), raw);
});

test('readState: ไฟล์เสีย/ผิดรูปแบบ/มี key ต้องห้าม → โยน error code=corrupt (ห้ามคืน null เพราะจะถูกตีความว่า "ไม่มีอะไรให้ลบ")', () => {
  const dir = path.join(process.env.BOTS_ROOT, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  const stamps = { createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' };
  const full = { version: 1, ...valid(), ...stamps };
  const { dnsRecordId, ...noDns } = full;
  const { tunnelId, ...noTunnel } = full;
  assert.equal(dnsRecordId, null);
  assert.equal(tunnelId, TID);
  // ฐานที่ถูกต้องต้องอ่านได้ — ไม่งั้นเคสผิดด้านล่างอาจล้มด้วยเหตุอื่นที่ไม่ใช่เหตุที่ตั้งใจทดสอบ
  fs.writeFileSync(path.join(dir, 'cloudflare.json'), JSON.stringify(full));
  assert.equal(state.readState('broken').tunnelId, TID);
  const bad = [
    '{not json',
    '[]',
    JSON.stringify({ ...full, version: 2 }),
    JSON.stringify({ ...full, tunnelToken: 'x'.repeat(40) }),
    JSON.stringify({ ...full, tunnelId: 'zzz' }),
    JSON.stringify({ ...full, createdAt: 'garbage' }),
    JSON.stringify({ ...full, updatedAt: 12345 }),
    JSON.stringify(noDns),
    JSON.stringify(noTunnel),
    '',
  ];
  for (const content of bad) {
    fs.writeFileSync(path.join(dir, 'cloudflare.json'), content);
    assert.throws(() => state.readState('broken'), (e) => CloudflareStateErrorLike(e) && e.code === 'corrupt', content);
  }
});

test('readState: ข้อความ error ของไฟล์เสียบอกสาเหตุ (JSON อ่านไม่ได้ vs รูปแบบไม่ตรง) เพื่อให้ผู้ดูแลตามต่อได้', () => {
  const file = path.join(process.env.BOTS_ROOT, 'broken', 'cloudflare.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => state.readState('broken'), /not valid JSON/);
  fs.writeFileSync(file, '[]');
  assert.throws(() => state.readState('broken'), /unexpected format/);
});

test('deleteState: ลบไฟล์แล้วคืน true; ไม่มีไฟล์คืน false ไม่ throw', () => {
  state.writeState('del', valid());
  assert.equal(state.deleteState('del'), true);
  assert.equal(fs.existsSync(stateFile('del')), false);
  assert.equal(state.deleteState('del'), false);
});

// ── รายการค้าง (orphans) ──────────────────────────────────────────────────────
test('orphans: ว่างเมื่อไม่มีไฟล์; addOrphan แล้ว listOrphans เห็น; เขียน 0600 แบบ atomic', () => {
  assert.deepEqual(state.listOrphans(), []);
  spyFs(({ writes, renames }) => {
    state.addOrphan({ botName: 'shop', hostname: 'shop.example.com', tunnelId: TID, dnsRecordId: REC, accountId: ACCT, zoneId: ZONE, reason: 'delete-tunnel-failed' });
    assert.equal(writes[0].opts.mode, 0o600);
    assert.deepEqual(renames, [{ from: writes[0].file, to: orphansFile() }]);
  });
  const list = state.listOrphans();
  assert.equal(list.length, 1);
  assert.equal(list[0].tunnelId, TID);
  assert.equal(list[0].reason, 'delete-tunnel-failed');
  assert.ok(Date.parse(list[0].createdAt));
});

test('orphans: addOrphan tunnelId เดิมซ้ำ = อัปเดตรายการเดิม ไม่เพิ่มแถว (idempotent)', () => {
  state.addOrphan({ botName: 'shop', hostname: 'shop.example.com', tunnelId: TID, dnsRecordId: null, accountId: ACCT, zoneId: ZONE, reason: 'again' });
  const list = state.listOrphans();
  assert.equal(list.filter((o) => o.tunnelId === TID).length, 1);
  assert.equal(list.find((o) => o.tunnelId === TID).reason, 'again');
});

test('orphans: removeOrphan ลบตาม tunnelId; ไม่พบคืน false', () => {
  state.addOrphan({ botName: 'b2', hostname: 'b2.example.com', tunnelId: TID2, dnsRecordId: null, accountId: ACCT, zoneId: ZONE, reason: 'x' });
  assert.equal(state.removeOrphan(TID2), true);
  assert.equal(state.listOrphans().some((o) => o.tunnelId === TID2), false);
  assert.equal(state.removeOrphan(TID2), false);
});

test('orphans: ปฏิเสธ key ต้องห้าม/ค่าผิด; ไฟล์เสีย → error code=corrupt ไม่ใช่ว่างเปล่า', () => {
  assert.throws(() => state.addOrphan({ botName: 'x1', hostname: 'x1.example.com', tunnelId: TID, accountId: ACCT, zoneId: ZONE, reason: 'r', token: 'x'.repeat(40) }), CloudflareStateErrorLike);
  assert.throws(() => state.addOrphan({ botName: 'x1', hostname: 'BAD HOST', tunnelId: TID, accountId: ACCT, zoneId: ZONE, reason: 'r' }), CloudflareStateErrorLike);
  assert.throws(() => state.addOrphan({ botName: '../x', hostname: 'x1.example.com', tunnelId: TID, accountId: ACCT, zoneId: ZONE, reason: 'r' }), CloudflareStateErrorLike);

  fs.writeFileSync(orphansFile(), '{broken');
  assert.throws(() => state.listOrphans(), (e) => CloudflareStateErrorLike(e) && e.code === 'corrupt');
  assert.throws(() => state.addOrphan({ botName: 'x1', hostname: 'x1.example.com', tunnelId: TID, accountId: ACCT, zoneId: ZONE, reason: 'r' }), (e) => e.code === 'corrupt');
  assert.equal(fs.readFileSync(orphansFile(), 'utf8'), '{broken'); // ไม่เขียนทับไฟล์ที่เสียแบบเงียบๆ
  fs.rmSync(orphansFile());
});

test('orphans: reason ถูกตัดความยาว และไฟล์ไม่มีคำว่า token', () => {
  state.addOrphan({ botName: 'long', hostname: 'long.example.com', tunnelId: TID2, dnsRecordId: null, accountId: ACCT, zoneId: ZONE, reason: 'r'.repeat(1000) });
  const raw = fs.readFileSync(orphansFile(), 'utf8');
  assert.ok(state.listOrphans().every((o) => o.reason.length <= 200));
  assert.ok(raw.length < 1500);
  assert.ok(!/token|secret|password/i.test(raw));
  fs.rmSync(orphansFile());
});

test('orphans: JSON ถูกแต่รูปแบบไม่ใช่ที่เราเขียน (array, version อื่น, orphans ไม่ใช่ array) → corrupt และไม่ถูกเขียนทับ', () => {
  for (const content of ['[]', '{"version":2,"orphans":[]}', '{"version":1,"orphans":"x"}', 'null']) {
    fs.writeFileSync(orphansFile(), content);
    assert.throws(() => state.listOrphans(), (e) => CloudflareStateErrorLike(e) && e.code === 'corrupt', content);
    assert.throws(() => state.removeOrphan(TID), (e) => e.code === 'corrupt', content);
    assert.equal(fs.readFileSync(orphansFile(), 'utf8'), content);
  }
  fs.rmSync(orphansFile());
});
