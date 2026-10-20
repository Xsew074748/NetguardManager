// client Cloudflare กับ "ผลจริง" ที่ได้จากการทดสอบกับ Cloudflare จริง 2026-10-20 (tests/fixtures/cloudflare-live-2026-10-20.js)
// ใช้ fetch จำลองที่ตอบด้วย fixture นั้น — ไม่เรียก Cloudflare จริง; ยืนยันว่า client ตีความผลจริงถูก:
//   DELETE DNS ซ้ำ = 404 รหัส 81044 · DELETE tunnel ซ้ำ = 200 · GET tunnel ที่ลบแล้ว = 200 + deleted_at · list ไม่นับตัวที่ลบแล้ว · token 240 ตัว
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCloudflareClient } = require('../services/cloudflare');
const fx = require('./fixtures/cloudflare-live-2026-10-20');

const SECRET = 'cfapitoken_LIVE_FIXTURE_0123456789abcdefghij';
const BASE = 'https://api.cloudflare.com/client/v4';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error('global fetch ถูกเรียก — ต้องฉีด fetch จำลองเท่านั้น'); }; });
test.after(() => { globalThis.fetch = realFetch; });

// queue: {status, body, headers}  — ตอบตามลำดับ
function harness(queue, opts = {}) {
  const calls = [];
  const sleeps = [];
  const q = [...queue];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname.replace('/client/v4', ''), query: Object.fromEntries(u.searchParams), body: init.body });
    const r = q.shift();
    if (!r) throw new Error('fetch ถูกเรียกเกินที่เตรียมไว้');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...fx.rateHeaders, ...(r.headers || {}) } });
  };
  const client = createCloudflareClient({
    accountId: fx.ACCT, zoneId: fx.ZONE, getToken: () => SECRET, fetch,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 1, timeoutMs: 1000, maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, ...opts,
  });
  return { client, calls, sleeps };
}
const ok = (body) => ({ status: 200, body });
const label = (c) => `${c.method} ${c.path}`;
const tunnelPath = `/accounts/${fx.ACCT}/cfd_tunnel/${fx.TID}`;
const dnsPath = `/zones/${fx.ZONE}/dns_records`;

// ── DNS ─────────────────────────────────────────────────────────────────────
test('findDnsRecords: คำตอบจริง (result_info มี total_pages) ผ่านการตรวจ "ครบ" และได้ record ที่ถูกต้อง', async () => {
  const h = harness([ok(fx.dnsListOne())]);
  const rows = await h.client.findDnsRecords(fx.HOST);
  assert.equal(rows.length, 1);
  assert.deepEqual({ type: rows[0].type, proxied: rows[0].proxied, content: rows[0].content }, { type: 'CNAME', proxied: true, content: `${fx.TID}.cfargotunnel.com` });
  assert.equal(h.calls[0].query['name.exact'], fx.HOST);
});

test('findDnsRecords: Cloudflare ไม่สนตัวพิมพ์ของ name — record ที่ตอบกลับชื่อตัวพิมพ์ต่างจากที่ขอก็ยังถูกนับ (กรองซ้ำแบบไม่สนตัวพิมพ์)', async () => {
  const body = { ...fx.dnsListOne(), result: [{ ...fx.dnsListOne().result[0], name: 'CF-LiveTest.Example.COM' }] };
  const rows = await harness([ok(body)]).client.findDnsRecords(fx.HOST);
  assert.equal(rows.length, 1);
});

test('findDnsRecords: รายการว่างจริง (total_pages 0) = ไม่มี record', async () => {
  assert.deepEqual(await harness([ok(fx.dnsListEmpty())]).client.findDnsRecords(fx.HOST), []);
});

test('deleteDnsRecord: DELETE ได้ 404 รหัส 81044 แต่ list ซ้ำไม่พบแล้ว → alreadyGone (ลำดับ: list → DELETE → list)', async () => {
  const h = harness([ok(fx.dnsListOne()), { status: 404, body: fx.dnsDelete404() }, ok(fx.dnsListEmpty())]);
  assert.deepEqual(await h.client.deleteDnsRecord(fx.REC, { hostname: fx.HOST, tunnelId: fx.TID }), { deleted: false, alreadyGone: true });
  assert.deepEqual(h.calls.map(label), [`GET ${dnsPath}`, `DELETE ${dnsPath}/${fx.REC}`, `GET ${dnsPath}`]);
});

test('deleteDnsRecord: DELETE ได้ 404 รหัส 81044 แต่ list ซ้ำยังเห็น record → ไม่สรุปว่าลบแล้ว (delete-unconfirmed ไม่ใช่ alreadyGone)', async () => {
  const h = harness([ok(fx.dnsListOne()), { status: 404, body: fx.dnsDelete404() }, ok(fx.dnsListOne())]);
  await assert.rejects(h.client.deleteDnsRecord(fx.REC, { hostname: fx.HOST, tunnelId: fx.TID }), (e) => e.code === 'delete-unconfirmed');
});

test('deleteDnsRecord: เรียกซ้ำหลังลบแล้ว → list ว่าง = alreadyGone โดยไม่ส่ง DELETE สักคำขอ', async () => {
  const h = harness([ok(fx.dnsListEmpty())]);
  assert.deepEqual(await h.client.deleteDnsRecord(fx.REC, { hostname: fx.HOST, tunnelId: fx.TID }), { deleted: false, alreadyGone: true });
  assert.deepEqual(h.calls.map(label), [`GET ${dnsPath}`]);
});

test('รหัส 81044 ถูกเก็บใน cfCodes ของ error (ไว้ให้ผู้เรียกดูได้) แต่การตัดสินใช้ HTTP 404 + list ซ้ำ ไม่ผูกกับรหัสนี้', async () => {
  // ถ้า Cloudflare เปลี่ยนรหัสเป็นอย่างอื่น พฤติกรรมต้องเหมือนเดิม
  for (const code of [81044, 1003, 99999]) {
    const h = harness([ok(fx.dnsListOne()), { status: 404, body: { success: false, errors: [{ code, message: 'x' }], messages: [], result: null } }, ok(fx.dnsListEmpty())]);
    assert.equal((await h.client.deleteDnsRecord(fx.REC, { hostname: fx.HOST, tunnelId: fx.TID })).alreadyGone, true, String(code));
  }
});

// ── tunnel ──────────────────────────────────────────────────────────────────
test('deleteTunnel: tunnel ยังอยู่ (GET) → DELETE ตอบ 200 → {deleted:true} ไม่เรียก cleanup connections', async () => {
  const h = harness([ok(fx.tunnelGetLive()), ok(fx.tunnelDeleteOk())]);
  assert.deepEqual(await h.client.deleteTunnel(fx.TID, { expectedName: fx.NAME }), { deleted: true, alreadyGone: false });
  assert.deepEqual(h.calls.map(label), [`GET ${tunnelPath}`, `DELETE ${tunnelPath}`]);
});

test('deleteTunnel: tunnel ถูกลบไปแล้ว — GET ตอบ 200 + deleted_at → alreadyGone และ "ไม่ส่ง DELETE ซ้ำ" (ที่จริง DELETE ซ้ำก็ตอบ 200 แต่ไม่จำเป็น)', async () => {
  const h = harness([ok(fx.tunnelGetDeleted())]);
  assert.deepEqual(await h.client.deleteTunnel(fx.TID, { expectedName: fx.NAME }), { deleted: false, alreadyGone: true });
  assert.deepEqual(h.calls.map(label), [`GET ${tunnelPath}`]);
});

test('deleteTunnel: DELETE ซ้ำที่ตอบ 200 (เช่นถูกลบโดยอีกฝั่งระหว่าง GET กับ DELETE) ถือว่าสำเร็จ ไม่ใช่ error และไม่ไปเรียก cleanup', async () => {
  const h = harness([ok(fx.tunnelGetLive()), ok(fx.tunnelDeleteOk())]);
  const r = await h.client.deleteTunnel(fx.TID, { expectedName: fx.NAME });
  assert.equal(r.deleted, true);
  assert.ok(!h.calls.some((c) => c.path.endsWith('/connections')));
});

test('deleteTunnel: tunnel ที่ลบแล้วแต่ชื่อไม่ตรง (deleted_at มีค่า) → ยังปฏิเสธเพราะชื่อก่อน (ไม่สรุปว่า "ลบแล้ว" ให้ของคนอื่น)', async () => {
  const other = { ...fx.tunnelGetDeleted(), result: { ...fx.tunnelGetDeleted().result, name: 'it-monitor' } };
  await assert.rejects(harness([ok(other)]).client.deleteTunnel(fx.TID, { expectedName: fx.NAME }), (e) => e.code === 'not-owned');
});

test('findTunnelsByName: ส่ง is_deleted=false และไม่นับ tunnel ที่ลบแล้ว (deleted_at มีค่า) แม้ API ส่งมาปน', async () => {
  const mixed = fx.tunnelListLive([fx.tunnelGetDeleted().result, { ...fx.tunnelGetLive().result, id: '3a3f2c1e-9b47-4d6a-8c15-0e7d2b9a1f65' }]);
  const h = harness([ok(mixed)]);
  const found = await h.client.findTunnelsByName(fx.NAME);
  assert.equal(h.calls[0].query.is_deleted, 'false');
  assert.equal(h.calls[0].query.name, fx.NAME);
  assert.deepEqual(found.map((t) => t.id), ['3a3f2c1e-9b47-4d6a-8c15-0e7d2b9a1f65']);
});

test('findTunnelsByName หลังลบจริง: คำตอบที่ is_deleted=false ว่าง → ไม่มี tunnel (ตรวจซ้ำหลังลบผ่าน)', async () => {
  assert.deepEqual(await harness([ok(fx.tunnelListLive([]))]).client.findTunnelsByName(fx.NAME), []);
});

test('findTunnelById หลังลบ: is_deleted=false ว่าง → null; ถ้าเรียก is_deleted=true จะเห็น 1 รายการ (ไม่ใช่สิ่งที่ client ใช้)', async () => {
  const h = harness([ok(fx.tunnelListLive([]))]);
  assert.equal(await h.client.findTunnelById(fx.TID), null);
  assert.equal(h.calls[0].query.uuid, fx.TID);
  assert.equal(h.calls[0].query.is_deleted, 'false');
});

// ── token ───────────────────────────────────────────────────────────────────
test('fixture token สังเคราะห์: ยาว 240, ขึ้นต้น ey, ชุด base64 มี + หรือ / และ padding =', () => {
  assert.equal(fx.TUNNEL_TOKEN_240.length, 240);
  assert.ok(fx.TUNNEL_TOKEN_240.startsWith('ey'));
  assert.match(fx.TUNNEL_TOKEN_240, /^[A-Za-z0-9+/=]+$/);
  assert.match(fx.TUNNEL_TOKEN_240, /[+/]/);
  assert.ok(fx.TUNNEL_TOKEN_240.endsWith('='));
});

test('createTunnel + getTunnelToken กับ token ยาว 240: ได้ค่าเดียวกัน, token ใน createTunnel ไม่ enumerable, ไม่รั่วใน JSON', async () => {
  const h = harness([ok(fx.tunnelCreate()), ok(fx.tokenResult())]);
  const t = await h.client.createTunnel(fx.NAME);
  assert.equal(t.id, fx.TID);
  assert.equal(t.token, fx.TUNNEL_TOKEN_240);
  assert.ok(!JSON.stringify(t).includes(fx.TUNNEL_TOKEN_240.slice(0, 40)));
  assert.equal(await h.client.getTunnelToken(fx.TID), fx.TUNNEL_TOKEN_240);
});

// ── rate limit (เห็นแต่ header ของคำตอบ 200 — ยังไม่เคยเห็น 429 จริง) ───────────────────
test('header ratelimit/ratelimit-policy แบบจริงในคำตอบ 200 ไม่รบกวนการทำงานของ client', async () => {
  const h = harness([ok(fx.dnsListEmpty()), ok(fx.dnsListEmpty())]);
  await h.client.findDnsRecords(fx.HOST);
  await h.client.findDnsRecords(fx.HOST);
  assert.deepEqual(h.sleeps, []);
});

test('429 ที่มีแต่ header ratelimit (ไม่มี Retry-After): client ใช้ backoff ปกติ (ยังไม่อ่าน ratelimit) — พฤติกรรมที่ตรึงไว้ เพราะยังไม่เคยเห็น 429 จริง', async () => {
  const h = harness([
    { status: 429, body: fx.dnsDelete404(), headers: { ratelimit: '"default";r=0;t=17' } },
    ok(fx.dnsListEmpty()),
  ]);
  await h.client.findDnsRecords(fx.HOST);
  assert.deepEqual(h.sleeps, [100]);
});

test('429 ที่มี Retry-After ยังเคารพ (ไม่ถูก header ratelimit ทับ)', async () => {
  const h = harness([
    { status: 429, body: fx.dnsDelete404(), headers: { 'retry-after': '3', ratelimit: '"default";r=0;t=17' } },
    ok(fx.dnsListEmpty()),
  ]);
  await h.client.findDnsRecords(fx.HOST);
  assert.deepEqual(h.sleeps, [3000]);
});
