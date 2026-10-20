// ค่าตั้งของฟีเจอร์ Cloudflare auto-tunnel (services/cloudflare-settings.js): flag เปิดได้ก็ต่อเมื่อมี ไฟล์ token + account ID + zone ID (+ zone name) ครบ
// ขาดอย่างใดอย่างหนึ่ง = ปิด และ log เหตุผล "เป็นชื่อตัวแปร" เท่านั้น ไม่แสดงค่า · ไม่มีการเรียก Cloudflare ในเทสต์นี้
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsLib = require('../services/cloudflare-settings');
const { validateAutoHostname } = require('../services/cloudflare-preflight');

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TOKEN = 'cfapitoken_SETTINGS_0123456789abcdefghij';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-cfset-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const tokenFile = path.join(dir, 'cf_token');
fs.writeFileSync(tokenFile, `${TOKEN}\n`);

const full = () => ({
  CF_ACCOUNT_ID: ACCT,
  CF_ZONE_ID: ZONE,
  CF_ZONE_NAME: 'example.com',
  CF_API_TOKEN_FILE: tokenFile,
});
const load = (env) => settingsLib.loadSettings(env);

test('ไม่ตั้งอะไรเลย → ปิด (configured=false) และไม่มีเหตุผลที่ต้องเตือน', () => {
  const s = load({});
  assert.equal(s.enabled, false);
  assert.equal(s.configured, false);
  assert.deepEqual(s.reasons, []);
});

test('ตั้งครบ + ไฟล์ token อ่านได้ → เปิด และ settings ไม่ถือค่า token', () => {
  const s = load(full());
  assert.equal(s.enabled, true);
  assert.equal(s.configured, true);
  assert.deepEqual(s.reasons, []);
  assert.equal(s.accountId, ACCT);
  assert.equal(s.zoneId, ZONE);
  assert.equal(s.zoneName, 'example.com');
  assert.ok(!JSON.stringify(s).includes(TOKEN));
});

test('ขาดอย่างใดอย่างหนึ่ง → ปิด และเหตุผลระบุชื่อตัวแปรที่ขาด', () => {
  for (const key of ['CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_API_TOKEN_FILE']) {
    const env = full();
    delete env[key];
    const s = load(env);
    assert.equal(s.enabled, false, key);
    assert.equal(s.configured, true, key);
    assert.ok(s.reasons.some((r) => r.includes(key)), `${key}: ${s.reasons.join(' | ')}`);
    if (key !== 'CF_API_TOKEN_FILE') assert.ok(s.reasons.includes(`${key} is not set`), `${key}: ต้องบอกว่า "ไม่ได้ตั้ง" ไม่ใช่ "รูปแบบผิด": ${s.reasons.join(' | ')}`);
  }
});

test('ค่า ID/zone name ผิดรูปแบบ → ปิด และเหตุผลไม่แสดงค่าที่ใส่มา', () => {
  const bad = 'not/a valid id & secret-looking-value-123';
  for (const key of ['CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME']) {
    const s = load({ ...full(), [key]: bad });
    assert.equal(s.enabled, false, key);
    assert.ok(s.reasons.some((r) => r.includes(key)));
    assert.ok(!s.reasons.join('\n').includes('secret-looking-value-123'), key);
  }
  assert.equal(load({ ...full(), CF_ZONE_NAME: 'Example.COM' }).enabled, false); // zone name ต้องเป็นตัวพิมพ์เล็ก
});

test('ไฟล์ token: ไม่มี / ว่าง / มีแต่ช่องว่าง / เป็นโฟลเดอร์ / ใหญ่เกิน / มีช่องว่างกลาง → ปิด', () => {
  const cases = {
    missing: path.join(dir, 'nope'),
    empty: path.join(dir, 'empty'),
    blank: path.join(dir, 'blank'),
    huge: path.join(dir, 'huge'),
    spaced: path.join(dir, 'spaced'),
    folder: dir,
  };
  fs.writeFileSync(cases.empty, '');
  fs.writeFileSync(cases.blank, ' \n\t\n');
  fs.writeFileSync(cases.huge, 'x'.repeat(5000));
  fs.writeFileSync(cases.spaced, 'abc def ghi jkl mno');
  for (const [name, file] of Object.entries(cases)) {
    const s = load({ ...full(), CF_API_TOKEN_FILE: file });
    assert.equal(s.enabled, false, name);
    assert.ok(s.reasons.some((r) => r.includes('CF_API_TOKEN_FILE')), name);
    assert.ok(!s.reasons.join('\n').includes(file), `${name}: ห้ามโชว์ path เต็มของไฟล์ลับ`);
  }
});

test('CF_AUTO_TUNNEL=false ปิดชัดเจนแม้ตั้งครบ; ค่าอื่นไม่เปลี่ยนผล', () => {
  const off = load({ ...full(), CF_AUTO_TUNNEL: 'false' });
  assert.equal(off.enabled, false);
  assert.ok(off.reasons.some((r) => r.includes('CF_AUTO_TUNNEL')));
  assert.equal(load({ ...full(), CF_AUTO_TUNNEL: 'true' }).enabled, true);
  assert.equal(load({ ...full(), CF_AUTO_TUNNEL: '' }).enabled, true);
});

test('CF_RESERVED_HOSTS: แยกด้วย , ตัดช่องว่าง/ตัวว่าง แปลงเป็นตัวพิมพ์เล็ก', () => {
  const s = load({ ...full(), CF_RESERVED_HOSTS: ' VIP , prod.example.com,, ' });
  assert.deepEqual(s.reserved, ['vip', 'prod.example.com']);
  assert.deepEqual(load(full()).reserved, []);
});

test('ชื่อสงวน "bot" (และ www ฯลฯ) ต้องอยู่เสมอ — ไม่มีค่า config ใดปลดได้', () => {
  const attempts = ['', '-bot', '!bot', 'bot=false', 'none', '*', '  '];
  for (const value of attempts) {
    const s = load({ ...full(), CF_RESERVED_HOSTS: value });
    for (const label of ['bot', 'www']) {
      assert.throws(
        () => validateAutoHostname(`${label}.example.com`, { zoneName: s.zoneName, reserved: s.reserved }),
        (e) => e.code === 'reserved-hostname',
        `${label} with CF_RESERVED_HOSTS=${JSON.stringify(value)}`,
      );
    }
  }
});

test('readToken: อ่านไฟล์ใหม่ทุกครั้ง (รองรับ rotate), ตัดช่องว่างท้าย, พังแล้ว error ที่ไม่มีค่า/พาธ', () => {
  const file = path.join(dir, 'rotating');
  fs.writeFileSync(file, 'first_token_value_0123456789\n');
  const s = load({ ...full(), CF_API_TOKEN_FILE: file });
  assert.equal(s.readToken(), 'first_token_value_0123456789');
  fs.writeFileSync(file, 'second_token_value_987654321\n');
  assert.equal(s.readToken(), 'second_token_value_987654321');
  fs.rmSync(file);
  assert.throws(() => s.readToken(), (e) => {
    assert.ok(!e.message.includes(file));
    assert.ok(!e.message.includes('token_value'));
    return true;
  });
  fs.writeFileSync(file, '   \n');
  assert.throws(() => s.readToken(), /token/i);
});

test('readToken: ฟังก์ชันไม่ enumerable ใน JSON และผลของ loadSettings ไม่มี token', () => {
  const s = load(full());
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  assert.ok(!Object.values(s).some((v) => typeof v === 'string' && v.includes(TOKEN)));
});

test('logSettings: ปิดเพราะตั้งไม่ครบ → warn พร้อมชื่อตัวแปร ไม่มีค่า; ไม่ได้ตั้งเลย → info บรรทัดเดียว; เปิด → info ไม่มี token/ID', () => {
  const logs = [];
  const logger = {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  };
  settingsLib.logSettings(load({}), logger);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'info');

  logs.length = 0;
  const env = full();
  delete env.CF_ZONE_ID;
  settingsLib.logSettings(load(env), logger);
  assert.ok(logs.some(([lvl, msg]) => lvl === 'warn' && msg.includes('CF_ZONE_ID')));
  assert.ok(!logs.map((l) => l[1]).join('\n').includes(ACCT));

  logs.length = 0;
  settingsLib.logSettings(load(full()), logger);
  const joined = logs.map((l) => l[1]).join('\n');
  assert.ok(logs.every(([lvl]) => lvl === 'info'));
  assert.ok(!joined.includes(TOKEN) && !joined.includes(ACCT) && !joined.includes(ZONE) && !joined.includes(tokenFile));
});

test('ค่าเริ่มต้น: โมดูลโหลดจาก process.env ได้ และ env ของเทสต์นี้ไม่ได้เปิดฟีเจอร์', () => {
  assert.equal(settingsLib.loadSettings().enabled, false);
});

test('CF_TIMEOUT_MS: ตั้งเป็นจำนวนบวกได้; ค่าเสีย/ศูนย์/ติดลบ → ใช้ 10000', () => {
  assert.equal(load({ ...full(), CF_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
  for (const bad of ['', 'abc', '0', '-5', 'Infinity']) assert.equal(load({ ...full(), CF_TIMEOUT_MS: bad }).timeoutMs, 10000, bad);
  assert.equal(load(full()).timeoutMs, 10000);
});
