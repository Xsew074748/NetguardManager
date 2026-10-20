// Cloudflare API client (services/cloudflare.js): ฉีด fetch/ตัวหน่วงเวลาได้ — เทสต์นี้ "ไม่เรียก Cloudflare จริง" และ "ไม่ต้องใช้ token จริง"
// ครอบคลุม: รูปแบบคำขอตามแผน (cf-auto-tunnel-plan.md), timeout, retry เฉพาะ GET/DELETE, ไม่ให้ token รั่วใน error, ตรวจ ID กัน path injection
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCloudflareClient, CloudflareError } = require('../services/cloudflare');

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '11111111-2222-4333-8444-555555555555';
const REC = 'abcdef0123456789abcdef0123456789';
const SECRET = 'cfapitoken_SECRET_0123456789abcdefghij';
const TUNNEL_TOKEN = 'eyJhIjoiQUNDVCIsInQiOiJUVU5ORUwifQ_tunneltoken_SECRET_1234567890';
const BASE = 'https://api.cloudflare.com/client/v4';

// ถ้าโค้ดหลุดไปเรียก fetch จริง ให้ล้มดังๆ แทนที่จะยิงออกเน็ต
const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = () => { throw new Error('global fetch ถูกเรียกในเทสต์ — ต้องฉีด fetch จำลองเท่านั้น'); };
});
test.after(() => { globalThis.fetch = realFetch; });

const ok = (result) => ({ status: 200, body: { success: true, errors: [], messages: [], result } });
const fail = (status, errors = [{ code: 1000, message: 'something broke' }], extra = {}) => ({
  status, body: { success: false, errors, messages: [], result: null, ...extra },
});

// queue: รายการคำตอบที่ใช้ทีละคำขอ — {status, body|raw, headers} | Error | function(init)
function harness(queue, opts = {}) {
  const calls = [];
  const sleeps = [];
  const q = [...queue];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    const r = q.shift();
    if (r === undefined) throw new Error('fetch ถูกเรียกเกินที่เทสต์เตรียมไว้');
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(init);
    return new Response(r.raw !== undefined ? r.raw : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  const client = createCloudflareClient({
    accountId: ACCT,
    zoneId: ZONE,
    getToken: () => SECRET,
    fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 1,
    timeoutMs: 1000,
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    ...opts,
  });
  return { client, calls, sleeps, left: () => q.length };
}

const jsonBody = (call) => JSON.parse(call.body);

// ── การสร้าง client ───────────────────────────────────────────────────────────
test('constructor: accountId/zoneId ต้องเป็นรหัสตัวอักษร-ตัวเลขไม่เกิน 32 ตัว (กัน path injection) และต้องมี getToken', () => {
  const base = { accountId: ACCT, zoneId: ZONE, getToken: () => SECRET, fetch: async () => {} };
  assert.throws(() => createCloudflareClient({ ...base, accountId: 'a/../b' }), /accountId/);
  assert.throws(() => createCloudflareClient({ ...base, zoneId: '' }), /zoneId/);
  assert.throws(() => createCloudflareClient({ ...base, zoneId: 'x'.repeat(33) }), /zoneId/);
  assert.throws(() => createCloudflareClient({ ...base, getToken: undefined }), /getToken/);
  assert.doesNotThrow(() => createCloudflareClient(base));
});

// ── รูปแบบคำขอ ────────────────────────────────────────────────────────────────
test('ทุกคำขอ: Bearer token จาก getToken (อ่านใหม่ทุกครั้ง) และ token ไม่อยู่ใน URL/body', async () => {
  let current = SECRET;
  const h = harness([ok([]), ok([])], { getToken: () => current });
  await h.client.findDnsRecords('a.example.com');
  current = 'rotated_token_value_0123456789abcdef';
  await h.client.findDnsRecords('a.example.com');
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(h.calls[1].headers.Authorization, 'Bearer rotated_token_value_0123456789abcdef');
  for (const c of h.calls) {
    assert.ok(!c.url.includes(SECRET));
    assert.ok(!String(c.body || '').includes(SECRET));
  }
});

test('createTunnel: POST /accounts/{acct}/cfd_tunnel {name, config_src:"cloudflare"} คืน id + token', async () => {
  const h = harness([ok({ id: TID, name: 'netguard-shop', token: TUNNEL_TOKEN })]);
  const t = await h.client.createTunnel('netguard-shop');
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].url, `${BASE}/accounts/${ACCT}/cfd_tunnel`);
  assert.deepEqual(jsonBody(h.calls[0]), { name: 'netguard-shop', config_src: 'cloudflare' });
  assert.equal(t.id, TID);
  assert.equal(t.token, TUNNEL_TOKEN);
});

test('createTunnel: token ไม่ enumerable — JSON.stringify/console.log/spread ไม่เห็น', async () => {
  const h = harness([ok({ id: TID, token: TUNNEL_TOKEN })]);
  const t = await h.client.createTunnel('netguard-shop');
  assert.ok(!JSON.stringify(t).includes(TUNNEL_TOKEN));
  assert.ok(!Object.keys(t).includes('token'));
  assert.ok(!JSON.stringify({ ...t }).includes(TUNNEL_TOKEN));
  assert.equal(t.token, TUNNEL_TOKEN); // แต่อ่านตรงๆ ได้
});

test('createTunnel: response ไม่มี token → token เป็น null (ผู้เรียกใช้ getTunnelToken แทน); ไม่มี id → error', async () => {
  const h1 = harness([ok({ id: TID })]);
  assert.equal((await h1.client.createTunnel('netguard-shop')).token, null);
  const h2 = harness([ok({ name: 'x' })]);
  await assert.rejects(h2.client.createTunnel('netguard-shop'), (e) => e instanceof CloudflareError && e.code === 'invalid-response');
});

test('createTunnel: ชื่อว่าง/ยาวเกิน/มีอักขระแปลก → ปฏิเสธก่อนยิง', async () => {
  const h = harness([]);
  for (const bad of ['', ' ', 'a'.repeat(300), 'x\ny', 42, undefined]) {
    await assert.rejects(h.client.createTunnel(bad), (e) => e instanceof CloudflareError && e.code === 'invalid-argument');
  }
  assert.equal(h.calls.length, 0);
});

test('getTunnelToken: GET .../cfd_tunnel/{id}/token คืนสตริง', async () => {
  const h = harness([ok(TUNNEL_TOKEN)]);
  assert.equal(await h.client.getTunnelToken(TID), TUNNEL_TOKEN);
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].url, `${BASE}/accounts/${ACCT}/cfd_tunnel/${TID}/token`);
});

test('getTunnelToken: result ไม่ใช่สตริง → error invalid-response', async () => {
  const h = harness([ok({ nope: 1 })]);
  await assert.rejects(h.client.getTunnelToken(TID), (e) => e.code === 'invalid-response');
});

test('putIngress: PUT .../configurations ใส่ hostname→service แล้วต่อด้วย catch-all http_status:404 เสมอ', async () => {
  const h = harness([ok({})]);
  await h.client.putIngress(TID, { hostname: 'shop.example.com', service: 'http://netguard-shop:3000' });
  assert.equal(h.calls[0].method, 'PUT');
  assert.equal(h.calls[0].url, `${BASE}/accounts/${ACCT}/cfd_tunnel/${TID}/configurations`);
  assert.deepEqual(jsonBody(h.calls[0]), {
    config: {
      ingress: [
        { hostname: 'shop.example.com', service: 'http://netguard-shop:3000' },
        { service: 'http_status:404' },
      ],
    },
  });
});

test('putIngress: hostname/service ผิดรูปแบบ → ปฏิเสธก่อนยิง', async () => {
  const h = harness([]);
  const bad = [
    { hostname: '', service: 'http://a:3000' },
    { hostname: 'UPPER.example.com', service: 'http://a:3000' },
    { hostname: '*.example.com', service: 'http://a:3000' },
    { hostname: 'a.example.com', service: '' },
    { hostname: 'a.example.com', service: 'javascript:alert(1)' },
    { hostname: 'a.example.com', service: 'http://a:3000\nhttp://b' },
  ];
  for (const b of bad) {
    await assert.rejects(h.client.putIngress(TID, b), (e) => e.code === 'invalid-argument', JSON.stringify(b));
  }
  assert.equal(h.calls.length, 0);
});

test('createCname: POST /zones/{zone}/dns_records CNAME proxied → <id>.cfargotunnel.com พร้อม comment; คืน id', async () => {
  const h = harness([ok({ id: REC })]);
  const r = await h.client.createCname({ hostname: 'shop.example.com', tunnelId: TID, comment: 'managed-by=netguard-manager bot=shop' });
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].url, `${BASE}/zones/${ZONE}/dns_records`);
  assert.deepEqual(jsonBody(h.calls[0]), {
    type: 'CNAME',
    name: 'shop.example.com',
    content: `${TID}.cfargotunnel.com`,
    proxied: true,
    comment: 'managed-by=netguard-manager bot=shop',
  });
  assert.deepEqual(r, { id: REC });
});

test('createCname: tunnelId/hostname ผิดรูปแบบ → ปฏิเสธก่อนยิง (ห้ามเอาค่าแปลกไปต่อท้าย cfargotunnel.com)', async () => {
  const h = harness([]);
  await assert.rejects(h.client.createCname({ hostname: 'shop.example.com', tunnelId: 'evil.com#' }), (e) => e.code === 'invalid-id');
  await assert.rejects(h.client.createCname({ hostname: 'bad host', tunnelId: TID }), (e) => e.code === 'invalid-argument');
  assert.equal(h.calls.length, 0);
});

test('findDnsRecords: GET dns_records?name.exact=<host> และกรองซ้ำฝั่งเราให้ชื่อตรงเป๊ะ (ไม่พึ่งว่า filter ฝั่ง Cloudflare ทำงาน)', async () => {
  const rows = [
    { id: 'r1', type: 'CNAME', name: 'shop.example.com', content: 'x.cfargotunnel.com', proxied: true },
    { id: 'r2', type: 'TXT', name: 'SHOP.example.com', content: 'hello' },
    { id: 'r3', type: 'A', name: 'other.example.com', content: '1.2.3.4' },
    { id: 'r4', type: 'A', name: 'shop.example.com.evil.net', content: '1.2.3.4' },
  ];
  const h = harness([ok(rows)]);
  const found = await h.client.findDnsRecords('shop.example.com');
  const u = new URL(h.calls[0].url);
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(u.pathname, `/client/v4/zones/${ZONE}/dns_records`);
  assert.equal(u.searchParams.get('name.exact'), 'shop.example.com');
  assert.deepEqual(found.map((r) => r.id), ['r1', 'r2']); // ไม่สนตัวพิมพ์ แต่ต้องชื่อตรงทั้งก้อน
  assert.equal(found[0].content, 'x.cfargotunnel.com');
});

test('findDnsRecords: result ไม่ใช่ array → error (ตรวจ DNS ไม่ได้ต้องไม่ถือว่า "ว่าง")', async () => {
  const h = harness([ok(null)]);
  await assert.rejects(h.client.findDnsRecords('shop.example.com'), (e) => e.code === 'invalid-response');
});

test('findTunnelsByName: GET cfd_tunnel?name=&is_deleted=false กรองซ้ำ ชื่อตรงและยังไม่ถูกลบ', async () => {
  const rows = [
    { id: TID, name: 'netguard-shop', deleted_at: null },
    { id: '22222222-2222-4333-8444-555555555555', name: 'netguard-shop', deleted_at: '2026-01-01T00:00:00Z' },
    { id: '33333333-2222-4333-8444-555555555555', name: 'netguard-shop2', deleted_at: null },
  ];
  const h = harness([ok(rows)]);
  const found = await h.client.findTunnelsByName('netguard-shop');
  const u = new URL(h.calls[0].url);
  assert.equal(u.pathname, `/client/v4/accounts/${ACCT}/cfd_tunnel`);
  assert.equal(u.searchParams.get('name'), 'netguard-shop');
  assert.equal(u.searchParams.get('is_deleted'), 'false');
  assert.deepEqual(found.map((t) => t.id), [TID]);
});

test('list ที่ Cloudflare บอกว่ามีมากกว่าที่ส่งมา (กรองไม่ทำงาน/ไม่ครบ) → error ไม่สรุปว่า "ไม่พบ"', async () => {
  const partial = (rows) => ({ status: 200, body: { success: true, errors: [], messages: [], result: rows, result_info: { count: rows.length, page: 1, per_page: 100, total_count: 500 } } });
  const d = harness([partial([{ id: 'r9', type: 'A', name: 'other.example.com', content: '1.2.3.4' }])]);
  await assert.rejects(d.client.findDnsRecords('shop.example.com'), (e) => e.code === 'invalid-response');
  const t = harness([partial([{ id: TID, name: 'netguard-other', deleted_at: null }])]);
  await assert.rejects(t.client.findTunnelsByName('netguard-shop'), (e) => e.code === 'invalid-response');
  // total_count เท่ากับที่ได้มา → ปกติ
  const fine = harness([{ status: 200, body: { success: true, errors: [], messages: [], result: [], result_info: { count: 0, total_count: 0 } } }]);
  assert.deepEqual(await fine.client.findDnsRecords('shop.example.com'), []);
});

test('deleteDnsRecord: DELETE /zones/{zone}/dns_records/{id}; 404 = ลบไปแล้ว (alreadyGone) ไม่ใช่ error', async () => {
  const h = harness([ok({ id: REC }), fail(404, [{ code: 81044, message: 'Record does not exist.' }])]);
  assert.deepEqual(await h.client.deleteDnsRecord(REC), { deleted: true, alreadyGone: false });
  assert.equal(h.calls[0].method, 'DELETE');
  assert.equal(h.calls[0].url, `${BASE}/zones/${ZONE}/dns_records/${REC}`);
  assert.deepEqual(await h.client.deleteDnsRecord(REC), { deleted: false, alreadyGone: true });
});

test('deleteDnsRecord: recordId ที่มี / หรือ .. → ปฏิเสธก่อนยิง', async () => {
  const h = harness([]);
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(40), undefined]) {
    await assert.rejects(h.client.deleteDnsRecord(bad), (e) => e.code === 'invalid-id');
  }
  assert.equal(h.calls.length, 0);
});

test('deleteTunnel: สำเร็จรอบแรก → ไม่เรียก cleanup connections', async () => {
  const h = harness([ok({ id: TID })]);
  assert.deepEqual(await h.client.deleteTunnel(TID), { deleted: true, alreadyGone: false });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'DELETE');
  assert.equal(h.calls[0].url, `${BASE}/accounts/${ACCT}/cfd_tunnel/${TID}`);
});

test('deleteTunnel: ล้ม (ไม่ว่ารหัสอะไร) → DELETE .../connections แล้วลองลบอีกครั้งเดียว (ไม่พึ่งรหัส error ที่เอกสารไม่ระบุ)', async () => {
  const h = harness([fail(400, [{ code: 1022, message: 'active connections' }]), ok({}), ok({ id: TID })]);
  assert.deepEqual(await h.client.deleteTunnel(TID), { deleted: true, alreadyGone: false });
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`), [
    `DELETE /accounts/${ACCT}/cfd_tunnel/${TID}`,
    `DELETE /accounts/${ACCT}/cfd_tunnel/${TID}/connections`,
    `DELETE /accounts/${ACCT}/cfd_tunnel/${TID}`,
  ]);
});

test('deleteTunnel: ลบซ้ำหลัง cleanup ก็ล้ม → throw (ไม่วนไม่รู้จบ) และ error อ้างขั้นตอน', async () => {
  const h = harness([fail(400), ok({}), fail(400)]);
  await assert.rejects(h.client.deleteTunnel(TID), (e) => e instanceof CloudflareError && /deleteTunnel/.test(e.message));
  assert.equal(h.calls.length, 3);
});

test('deleteTunnel: cleanup connections ล้ม → throw และไม่ลองลบรอบสอง', async () => {
  const h = harness([fail(400), fail(500, undefined), fail(500, undefined), fail(500, undefined), fail(500, undefined)], { maxRetries: 0 });
  await assert.rejects(h.client.deleteTunnel(TID), CloudflareError);
  assert.equal(h.calls.length, 2);
});

test('deleteTunnel: 404 = ลบไปแล้ว ไม่เรียก cleanup', async () => {
  const h = harness([fail(404, [{ code: 1003, message: 'not found' }])]);
  assert.deepEqual(await h.client.deleteTunnel(TID), { deleted: false, alreadyGone: true });
  assert.equal(h.calls.length, 1);
});

test('deleteTunnel: tunnelId ไม่ใช่ UUID → ปฏิเสธก่อนยิง', async () => {
  const h = harness([]);
  await assert.rejects(h.client.deleteTunnel('not-a-uuid'), (e) => e.code === 'invalid-id');
  assert.equal(h.calls.length, 0);
});

// ── retry ─────────────────────────────────────────────────────────────────────
test('retry GET: 503 สองครั้งแล้วสำเร็จ — หน่วงแบบเลขชี้กำลัง 100, 200 (random=1 → ไม่มี jitter ลด)', async () => {
  const h = harness([fail(503), fail(502), ok([])]);
  assert.deepEqual(await h.client.findDnsRecords('a.example.com'), []);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [100, 200]);
});

test('retry: jitter — random=0 ได้ครึ่งหนึ่งของค่าเลขชี้กำลัง และถูกจำกัดที่ maxDelayMs', async () => {
  const h = harness([fail(503), fail(503), fail(503), ok([])], { random: () => 0, baseDelayMs: 100, maxDelayMs: 150 });
  await h.client.findDnsRecords('a.example.com');
  assert.deepEqual(h.sleeps, [50, 75, 75]); // min(150, 100/200/400)/2
});

test('retry: 429 ที่มี Retry-After (วินาที) เคารพค่านั้น', async () => {
  const h = harness([{ ...fail(429), headers: { 'Retry-After': '2' } }, ok([])]);
  await h.client.findDnsRecords('a.example.com');
  assert.deepEqual(h.sleeps, [2000]);
});

test('retry: Retry-After ที่เกิน maxDelayMs ถูกจำกัด และค่าที่อ่านไม่ได้ใช้ backoff ปกติ', async () => {
  const h = harness([{ ...fail(429), headers: { 'Retry-After': '9999' } }, { ...fail(429), headers: { 'Retry-After': 'soon' } }, ok([])], { maxDelayMs: 3000 });
  await h.client.findDnsRecords('a.example.com');
  assert.deepEqual(h.sleeps, [3000, 200]);
});

test('retry: ครบ maxRetries แล้วยังล้ม → throw retryable=true, attempts=maxRetries+1', async () => {
  const h = harness([fail(503), fail(503), fail(503), fail(503), ok([])]);
  await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => e instanceof CloudflareError && e.status === 503 && e.retryable === true && e.attempts === 4);
  assert.equal(h.calls.length, 4);
  assert.equal(h.left(), 1);
});

test('retry: GET ที่ได้ 400/401/403/404 ไม่ retry (ยิงครั้งเดียว)', async () => {
  for (const status of [400, 401, 403, 404]) {
    const h = harness([fail(status), ok([])]);
    await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => e.status === status && e.retryable === false);
    assert.equal(h.calls.length, 1, `status ${status}`);
  }
});

test('retry: GET ที่ network error (fetch reject) ลองใหม่แล้วสำเร็จ', async () => {
  const h = harness([Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }), ok([])]);
  await h.client.findDnsRecords('a.example.com');
  assert.equal(h.calls.length, 2);
});

test('retry: DELETE ที่ 503 ลองใหม่ได้', async () => {
  const h = harness([fail(503), ok({ id: REC })]);
  assert.deepEqual(await h.client.deleteDnsRecord(REC), { deleted: true, alreadyGone: false });
  assert.equal(h.calls.length, 2);
});

test('ห้าม retry POST/PUT: 503, network error และ timeout ล้วนยิงครั้งเดียว (กันสร้างซ้ำ)', async () => {
  const cases = [
    (c) => c.createTunnel('netguard-shop'),
    (c) => c.putIngress(TID, { hostname: 'shop.example.com', service: 'http://netguard-shop:3000' }),
    (c) => c.createCname({ hostname: 'shop.example.com', tunnelId: TID }),
  ];
  for (const run of cases) {
    const a = harness([fail(503), ok({ id: TID })]);
    await assert.rejects(run(a.client), (e) => e.status === 503);
    assert.equal(a.calls.length, 1);

    const b = harness([new TypeError('fetch failed'), ok({ id: TID })]);
    await assert.rejects(run(b.client), (e) => e.code === 'network');
    assert.equal(b.calls.length, 1);

    const c = harness([fail(429), ok({ id: TID })]);
    await assert.rejects(run(c.client), (e) => e.status === 429);
    assert.equal(c.calls.length, 1);
    assert.deepEqual(c.sleeps, []);
  }
});

// ── timeout ───────────────────────────────────────────────────────────────────
const hang = (init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

test('timeout: ส่ง AbortSignal ไปกับทุกคำขอ และคำขอที่ค้างถูกตัดด้วย CloudflareError code=timeout', async () => {
  const h = harness([hang], { timeoutMs: 20, maxRetries: 0 });
  const started = Date.now();
  await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => e instanceof CloudflareError && e.code === 'timeout');
  assert.ok(Date.now() - started < 2000);
  assert.ok(h.calls[0].signal instanceof AbortSignal);
});

test('timeout: GET ที่ timeout ถูก retry; POST ที่ timeout ไม่ retry', async () => {
  const g = harness([hang, ok([])], { timeoutMs: 20 });
  assert.deepEqual(await g.client.findDnsRecords('a.example.com'), []);
  assert.equal(g.calls.length, 2);

  const p = harness([hang, ok({ id: TID })], { timeoutMs: 20 });
  await assert.rejects(p.client.createTunnel('netguard-shop'), (e) => e.code === 'timeout');
  assert.equal(p.calls.length, 1);
});

test('timeout: ค่าที่ไม่ใช่จำนวนบวก → constructor ปฏิเสธ (กันตั้งเป็น 0/NaN แล้วไม่มี timeout)', () => {
  const base = { accountId: ACCT, zoneId: ZONE, getToken: () => SECRET, fetch: async () => {} };
  for (const bad of [0, -1, NaN, 'x', Infinity]) {
    assert.throws(() => createCloudflareClient({ ...base, timeoutMs: bad }), /timeoutMs/);
  }
});

// ── ความลับต้องไม่รั่ว ────────────────────────────────────────────────────────
const everything = (e) => [e.message, e.stack, JSON.stringify(e, Object.getOwnPropertyNames(e)), String(e)].join('\n');

test('error จาก HTTP: มี op/status/รหัสและข้อความของ Cloudflare แต่ไม่มี body ส่วน result (ซึ่งอาจมี token)', async () => {
  const h = harness([fail(403, [{ code: 9109, message: 'Invalid access token' }], { result: { token: TUNNEL_TOKEN } })]);
  await assert.rejects(h.client.createTunnel('netguard-shop'), (e) => {
    assert.ok(e instanceof CloudflareError);
    assert.equal(e.status, 403);
    assert.deepEqual(e.cfCodes, [9109]);
    assert.match(e.message, /createTunnel/);
    assert.match(e.message, /9109/);
    assert.match(e.message, /Invalid access token/);
    assert.ok(!everything(e).includes(TUNNEL_TOKEN));
    assert.ok(!everything(e).includes(SECRET));
    return true;
  });
});

test('error จาก fetch ที่ข้อความมี token (เช่นสะท้อน header) → token ไม่อยู่ใน message/stack/JSON', async () => {
  const hostile = Object.assign(new Error(`request failed: Authorization: Bearer ${SECRET}`), { code: 'ECONNRESET' });
  const h = harness([hostile], { maxRetries: 0 });
  await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => {
    assert.equal(e.code, 'network');
    assert.ok(!everything(e).includes(SECRET));
    assert.equal(e.cause, undefined);
    return true;
  });
});

test('error: ข้อความจาก Cloudflare ที่ดันมี token (ค่า API token ปัจจุบัน หรือสตริงยาวหน้าตาเป็น token) ถูกปิดเป็น [redacted]', async () => {
  const longish = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
  const h = harness([fail(400, [{ code: 1, message: `bad ${SECRET} and ${longish}` }])]);
  await assert.rejects(h.client.createTunnel('netguard-shop'), (e) => {
    assert.ok(!everything(e).includes(SECRET));
    assert.ok(!everything(e).includes(longish));
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test('error: response ที่ไม่ใช่ JSON (HTML ของ 502) → CloudflareError มี status แต่ไม่คัดลอกเนื้อหา', async () => {
  const body = `<html>gateway ${TUNNEL_TOKEN}</html>`;
  const h = harness([{ status: 502, raw: body }], { maxRetries: 0 });
  await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => {
    assert.equal(e.status, 502);
    assert.ok(!everything(e).includes(TUNNEL_TOKEN));
    assert.ok(!everything(e).includes('<html>'));
    return true;
  });
});

test('error: HTTP 200 แต่ success:false ถือว่าล้ม', async () => {
  const h = harness([{ status: 200, body: { success: false, errors: [{ code: 7003, message: 'nope' }], result: null } }]);
  await assert.rejects(h.client.createCname({ hostname: 'shop.example.com', tunnelId: TID }), (e) => e.cfCodes[0] === 7003);
});

test('error: ข้อความจาก Cloudflare ยาวเกินถูกตัด (ไม่ให้ log ท่วม)', async () => {
  const h = harness([fail(400, [{ code: 5, message: 'word '.repeat(500) }])]);
  await assert.rejects(h.client.createTunnel('netguard-shop'), (e) => e.message.length < 400);
});

test('getToken ล้ม/คืนค่าว่าง → CloudflareError code=no-token และไม่ยิง fetch; ข้อความไม่ใส่ค่าที่ getToken โยนมา', async () => {
  for (const getToken of [() => '', () => undefined, () => { throw new Error(`cannot read ${SECRET}`); }, async () => null]) {
    const h = harness([ok([])], { getToken });
    await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => {
      assert.equal(e.code, 'no-token');
      assert.ok(!everything(e).includes(SECRET));
      return true;
    });
    assert.equal(h.calls.length, 0);
  }
});

test('token ที่มีขึ้นบรรทัดใหม่/ช่องว่าง → ปฏิเสธ (กัน header injection)', async () => {
  const h = harness([ok([])], { getToken: () => 'abc\r\nX-Evil: 1' });
  await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => e.code === 'no-token');
  assert.equal(h.calls.length, 0);
});

test('client ไม่ถือ token ไว้ในตัวเอง: JSON.stringify(client)/Object.values ไม่มี token', async () => {
  const h = harness([ok([])]);
  await h.client.findDnsRecords('a.example.com');
  assert.ok(!JSON.stringify(h.client).includes(SECRET));
  assert.ok(!Object.values(h.client).some((v) => typeof v === 'string' && v.includes(SECRET)));
});

// ── เทสต์เพิ่มจากผล mutation check รอบแรก ───────────────────────────────────────
test('error: token สั้น (ต่ำกว่า 24 ตัว ซึ่ง regex ทั่วไปจับไม่ได้) ที่โผล่ในข้อความของ Cloudflare ถูกปิดด้วยการเทียบค่าตรงๆ', async () => {
  const short = 'tok_Short12345';
  const h = harness([fail(400, [{ code: 1, message: `echo ${short} here` }])], { getToken: () => short });
  await assert.rejects(h.client.createTunnel('netguard-shop'), (e) => {
    assert.ok(!everything(e).includes(short));
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test('findDnsRecords/findTunnelsByName: hostname/ชื่อผิดรูปแบบ → ปฏิเสธก่อนยิง', async () => {
  const h = harness([]);
  for (const bad of ['Bad Host', '', 'UPPER.example.com', 'a..b.com', `${'x'.repeat(300)}.com`, undefined]) {
    await assert.rejects(h.client.findDnsRecords(bad), (e) => e.code === 'invalid-argument', String(bad));
  }
  for (const bad of ['', 'a b', undefined, 'x\ny']) {
    await assert.rejects(h.client.findTunnelsByName(bad), (e) => e.code === 'invalid-argument', String(bad));
  }
  assert.equal(h.calls.length, 0);
});

test('putIngress/getTunnelToken: tunnelId ที่ไม่ใช่ UUID → ปฏิเสธก่อนยิง', async () => {
  const h = harness([]);
  await assert.rejects(h.client.putIngress('not-a-uuid', { hostname: 'shop.example.com', service: 'http://a:3000' }), (e) => e.code === 'invalid-id');
  await assert.rejects(h.client.getTunnelToken('../x'), (e) => e.code === 'invalid-id');
  assert.equal(h.calls.length, 0);
});

test('HTTP 200 ที่ body ไม่ใช่ JSON → invalid-response (ไม่ retry, ไม่คัดลอกเนื้อหา)', async () => {
  const h = harness([{ status: 200, raw: `<html>${TUNNEL_TOKEN}</html>` }, ok([])]);
  await assert.rejects(h.client.findDnsRecords('a.example.com'), (e) => {
    assert.equal(e.code, 'invalid-response');
    assert.equal(e.retryable, false);
    assert.ok(!everything(e).includes(TUNNEL_TOKEN));
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('error: cfCodes เก็บเฉพาะรหัสที่เป็นจำนวนเต็ม', async () => {
  const h = harness([fail(400, [{ code: 'weird', message: 'a' }, { code: 1003, message: 'b' }, { message: 'c' }])]);
  await assert.rejects(h.client.createTunnel('netguard-shop'), (e) => {
    assert.deepEqual(e.cfCodes, [1003]);
    return true;
  });
});
