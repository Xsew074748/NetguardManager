'use strict';
// หน้าเว็บของ auto-tunnel: ฟังก์ชันล้วน (public/js/cloudflare-ui.js) ทดสอบใน vm + ตรวจโครงสร้าง HTML/JS ระดับซอร์ส (ไม่มีเบราว์เซอร์จริง)
// หลักการ: flag ปิด → หน้าเว็บและคำขอเหมือนเดิมทุกอย่าง (ส่วนใหม่ซ่อนไว้, payload/URL เดิม)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(publicDir, p), 'utf8').replace(/\r\n/g, '\n');

function loadUi() {
  const ctx = vm.createContext({});
  vm.runInContext(read('js/cloudflare-ui.js'), ctx);
  return ctx;
}

function loadApi() {
  const calls = [];
  const ctx = vm.createContext({
    window: { location: { href: '' } },
    fetch: async (url, opts) => { calls.push({ url, opts }); return { status: 200, ok: true, json: async () => ({ ok: true }) }; },
    encodeURIComponent,
    URLSearchParams,
  });
  vm.runInContext(read('js/api.js'), ctx);
  return { ctx, calls };
}

// ── buildCreatePayload ───────────────────────────────────────────────────────
test('buildCreatePayload: ไม่ติ๊ก auto = payload เดิมเป๊ะ (ไม่มี key autoTunnel/hostname) แม้ flag เปิด', () => {
  const { buildCreatePayload } = loadUi();
  const base = { name: 'shop', port: 3101, tunnelToken: 'tok_'.padEnd(30, 'x'), companyName: 'ACME' };
  assert.deepEqual(JSON.parse(JSON.stringify(buildCreatePayload({ ...base, autoTunnel: false, hostname: 'shop.example.com', featureOn: true }))),
    { name: 'shop', port: 3101, tunnelToken: base.tunnelToken, companyName: 'ACME' });
  assert.deepEqual(JSON.parse(JSON.stringify(buildCreatePayload({ name: 'shop', port: 3101, tunnelToken: '', companyName: '', autoTunnel: false, featureOn: false }))),
    { name: 'shop', port: 3101 });
});

test('buildCreatePayload: flag ปิด → ติ๊ก auto มาก็ถูกมองข้าม (กันกรณีหน้าเว็บค้างค่าเก่า)', () => {
  const { buildCreatePayload } = loadUi();
  const p = JSON.parse(JSON.stringify(buildCreatePayload({ name: 'shop', port: 3101, tunnelToken: '', companyName: '', autoTunnel: true, hostname: 'shop.example.com', featureOn: false })));
  assert.deepEqual(p, { name: 'shop', port: 3101 });
});

test('buildCreatePayload: ติ๊ก auto + flag เปิด → ส่ง autoTunnel:true + hostname (ตัวพิมพ์เล็ก ตัดช่องว่าง) และ "ไม่ส่ง token" แม้กรอกไว้', () => {
  const { buildCreatePayload } = loadUi();
  const p = JSON.parse(JSON.stringify(buildCreatePayload({ name: 'shop', port: 3101, tunnelToken: 'tok_'.padEnd(30, 'x'), companyName: 'ACME', autoTunnel: true, hostname: '  Shop.Example.com ', featureOn: true })));
  assert.deepEqual(p, { name: 'shop', port: 3101, companyName: 'ACME', autoTunnel: true, hostname: 'shop.example.com' });
});

// ── autoHostnameProblem ──────────────────────────────────────────────────────
test('autoHostnameProblem: ว่าง/นอก zone/ลึกเกิน/มีอักขระแปลก → ข้อความ; <label>.<zone> → ว่าง', () => {
  const { autoHostnameProblem } = loadUi();
  assert.equal(autoHostnameProblem('shop.example.com', 'example.com'), '');
  assert.equal(autoHostnameProblem(' Shop.Example.com ', 'example.com'), '');
  for (const bad of ['', '   ', 'example.com', 'shop.other.com', 'a.b.example.com', 'sh op.example.com', '*.example.com', 'shop.example.com/x', 'https://shop.example.com']) {
    assert.ok(autoHostnameProblem(bad, 'example.com'), JSON.stringify(bad));
  }
  assert.ok(autoHostnameProblem('shop.example.com', ''), 'ไม่รู้ zone ต้องไม่ผ่าน');
});

// ── tunnelToastFor ───────────────────────────────────────────────────────────
test('tunnelToastFor: ไม่มี tunnel ในผล (ทางเดิม) → null (ไม่เพิ่ม toast ใด)', () => {
  const { tunnelToastFor } = loadUi();
  assert.equal(tunnelToastFor('shop', undefined), null);
  assert.equal(tunnelToastFor('shop', null), null);
});

test('tunnelToastFor: ok → success; failed → error พร้อมขั้น, ข้อความ, สถานะ rollback และคำแนะนำให้ลองใหม่', () => {
  const { tunnelToastFor } = loadUi();
  const ok = tunnelToastFor('shop', { status: 'ok', hostname: 'shop.example.com' });
  assert.equal(ok.type, 'success');
  assert.match(ok.text, /shop\.example\.com/);

  const failed = (rollback) => tunnelToastFor('shop', { status: 'failed', step: 'create-dns', message: 'cloudflare createCname: HTTP 400', hostname: 'shop.example.com', rollback });
  const clean = failed({ ok: true, failed: [], orphaned: false });
  assert.equal(clean.type, 'error');
  assert.match(clean.text, /create-dns/);
  assert.match(clean.text, /HTTP 400/);
  assert.match(clean.text, /ลองใหม่/);
  assert.match(clean.text, /ย้อนกลับ/);

  assert.match(failed({ ok: false, failed: ['tunnel'], orphaned: true }).text, /ค้าง/);
  assert.match(failed({ ok: true, failed: [], orphaned: false, unknown: true }).text, /ตรวจ/);
  assert.match(failed({ ok: false, failed: ['dns'], orphaned: false }).text, /log/);
});

// ── removeRequestOptions / removeToast ───────────────────────────────────────
test('removeRequestOptions: บอทที่ไม่มี cloudflare state → deleteCloudflare undefined (คำขอเหมือนเดิม)', () => {
  const { removeRequestOptions } = loadUi();
  for (const featureOn of [true, false]) {
    assert.equal(removeRequestOptions({ bot: { id: 'a' }, featureOn, checked: true }).deleteCloudflare, undefined);
    assert.equal(removeRequestOptions({ bot: undefined, featureOn, checked: true }).deleteCloudflare, undefined);
  }
});

test('removeRequestOptions: บอทมี state → ตามช่องติ๊กเมื่อ flag เปิด; flag ปิด = false ชัดเจน (ไม่ลองลบ)', () => {
  const { removeRequestOptions } = loadUi();
  const bot = { cloudflare: { hostname: 'shop.example.com' } };
  assert.equal(removeRequestOptions({ bot, featureOn: true, checked: true }).deleteCloudflare, true);
  assert.equal(removeRequestOptions({ bot, featureOn: true, checked: false }).deleteCloudflare, false);
  assert.equal(removeRequestOptions({ bot, featureOn: false, checked: true }).deleteCloudflare, false);
});

test('removeToast: ไม่มี cloudflare ในคำตอบ → ข้อความเดิมเป๊ะ; removed/partial/kept มีข้อความและชนิดต่างกัน', () => {
  const { removeToast } = loadUi();
  assert.deepEqual(JSON.parse(JSON.stringify(removeToast('shop', false, { ok: true }))), { text: 'ลบ bot "shop" สำเร็จ', type: 'success' });
  assert.deepEqual(JSON.parse(JSON.stringify(removeToast('shop', true, { ok: true }))), { text: 'ลบ bot "shop" สำเร็จ (รวมไฟล์)', type: 'success' });
  assert.deepEqual(JSON.parse(JSON.stringify(removeToast('shop', false, undefined))), { text: 'ลบ bot "shop" สำเร็จ', type: 'success' });

  const removed = removeToast('shop', false, { ok: true, cloudflare: { status: 'removed' } });
  assert.equal(removed.type, 'success');
  assert.match(removed.text, /Cloudflare/);

  const partial = removeToast('shop', true, { ok: true, cloudflare: { status: 'partial', rollback: { failed: ['tunnel'], orphaned: true } } });
  assert.equal(partial.type, 'error');
  assert.match(partial.text, /ค้าง/);

  const keptFiles = removeToast('shop', true, { ok: true, cloudflare: { status: 'kept' } });
  assert.equal(keptFiles.type, 'info');
  assert.match(keptFiles.text, /รายการค้าง/);
  const keptNoFiles = removeToast('shop', false, { ok: true, cloudflare: { status: 'kept' } });
  assert.equal(keptNoFiles.type, 'info');
  assert.doesNotMatch(keptNoFiles.text, /รายการค้าง/);
});

// ── รายการค้าง ───────────────────────────────────────────────────────────────
test('orphanSummary: ชื่อบอท/hostname และขั้นที่ค้างเป็นภาษาไทย; leftovers ว่าง = ทุกขั้น', () => {
  const { orphanSummary } = loadUi();
  const s = orphanSummary({ botName: 'shop', hostname: 'shop.example.com', leftovers: ['dns', 'tunnel'] });
  assert.equal(s.title, 'shop — shop.example.com');
  assert.match(s.detail, /DNS/);
  assert.match(s.detail, /Tunnel/);
  assert.ok(!/container/.test(s.detail));
  const all = orphanSummary({ botName: 'shop', hostname: 'shop.example.com', leftovers: [] });
  for (const word of ['container', 'DNS', 'Tunnel', '.env']) assert.match(all.detail, new RegExp(word));
});

test('cleanupToast: cleaned → success; partial → error บอกขั้นที่ยังค้าง', () => {
  const { cleanupToast } = loadUi();
  assert.equal(cleanupToast({ status: 'cleaned', failed: [] }).type, 'success');
  const p = cleanupToast({ status: 'partial', failed: ['tunnel'] });
  assert.equal(p.type, 'error');
  assert.match(p.text, /Tunnel/);
});

// ── api.js ───────────────────────────────────────────────────────────────────
test('apiRemoveBot: เรียกแบบเดิม (2 พารามิเตอร์) ได้ URL เดิมเป๊ะ; ใส่ deleteCloudflare แล้วต่อท้าย', async () => {
  const { ctx, calls } = loadApi();
  await ctx.apiRemoveBot('abc', true);
  await ctx.apiRemoveBot('abc', false);
  await ctx.apiRemoveBot('abc', false, true);
  await ctx.apiRemoveBot('abc', true, false);
  assert.deepEqual(calls.map((c) => c.url), [
    '/api/bots/abc?deleteFiles=true',
    '/api/bots/abc?deleteFiles=false',
    '/api/bots/abc?deleteFiles=false&deleteCloudflare=true',
    '/api/bots/abc?deleteFiles=true&deleteCloudflare=false',
  ]);
  assert.ok(calls.every((c) => c.opts.method === 'DELETE'));
});

test('api.js: ฟังก์ชันใหม่ (features / auto tunnel / orphans) ยิง URL และ method ถูกต้อง', async () => {
  const { ctx, calls } = loadApi();
  await ctx.apiGetFeatures();
  await ctx.apiAutoTunnel('shop', 'shop.example.com');
  await ctx.apiListCfOrphans();
  await ctx.apiCleanupCfOrphan('11111111-2222-4333-8444-555555555555');
  assert.deepEqual(calls.map((c) => [c.opts && c.opts.method || 'GET', c.url]), [
    ['GET', '/api/features'],
    ['POST', '/api/bots/shop/tunnel/auto'],
    ['GET', '/api/cloudflare/orphans'],
    ['POST', '/api/cloudflare/orphans/11111111-2222-4333-8444-555555555555/cleanup'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].opts.body), { hostname: 'shop.example.com' });
});

// ── index.html ───────────────────────────────────────────────────────────────
test('index.html: ส่วนใหม่ทั้งหมดซ่อนไว้ตั้งต้น (flag ปิด = หน้าเหมือนเดิม) และโหลด cloudflare-ui.js ก่อน modals.js', () => {
  const html = read('index.html');
  for (const id of ['autoTunnelSection', 'removeCloudflareRow', 'cfOrphansBtn']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\bhidden\\b|\\bhidden\\b[^>]*id="${id}"`), `${id} ต้องมี hidden`);
  }
  for (const id of ['newBotAutoTunnel', 'newBotHostname', 'removeDeleteCloudflare', 'autoTunnelModal', 'autoTunnelHostname', 'autoTunnelSubmitBtn', 'cfOrphansModal', 'cfOrphansList']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('js/cloudflare-ui.js') > 0);
  assert.ok(html.indexOf('js/cloudflare-ui.js') < html.indexOf('js/modals.js'));
  // ช่องกรอก token เองเดิมยังอยู่
  assert.match(html, /id="newBotToken"/);
});

// ── modals.js / render.js / app.js (ระดับซอร์ส) ───────────────────────────────────
test('modals.js: สร้างบอทผ่าน buildCreatePayload; ลบบอทส่ง deleteCloudflare ผ่าน removeRequestOptions; ผลลัพธ์ผ่าน toast helper', () => {
  const src = read('js/modals.js');
  assert.match(src, /buildCreatePayload\(/);
  assert.match(src, /removeRequestOptions\(/);
  assert.match(src, /removeToast\(/);
  assert.match(src, /tunnelToastFor\(/);
  assert.match(src, /apiAutoTunnel\(/);
  assert.match(src, /apiCleanupCfOrphan\(/);
  assert.doesNotMatch(src, /apiCreateBot\(\{ name, port, tunnelToken/);
});

test('modals.js: รายการค้างใส่ข้อความด้วย textContent (ค่าจาก server ห้ามเข้า innerHTML)', () => {
  const src = read('js/modals.js');
  const block = src.slice(src.indexOf('function renderCfOrphans'), src.indexOf('function renderCfOrphans') + 2500);
  assert.match(block, /textContent/);
  assert.doesNotMatch(block, /innerHTML\s*=\s*[^'"\s]*(hostname|botName|reason|detail|title)/);
});

test('render.js: เมนู "สร้าง Tunnel อัตโนมัติ" ขึ้นเฉพาะบอทที่ไม่มี tunnel และเมื่อ flag เปิด', () => {
  const src = read('js/render.js');
  assert.match(src, /data-action="tunnel-auto"/);
  assert.match(src, /!hasTunnel && cloudflareFeature\.cloudflareAutoTunnel/);
});

test('app.js: โหลด features/รายการค้างตอนเริ่ม; ค่าเริ่มต้นของ cloudflareFeature = ปิด', () => {
  const src = read('js/app.js');
  assert.match(src, /let cloudflareFeature = \{ cloudflareAutoTunnel: false \}/);
  assert.match(src, /apiGetFeatures\(\)/);
  assert.match(src, /refreshCfOrphans\(\)/);
});

// ── เทสต์เพิ่ม ───────────────────────────────────────────────────────────────
test('toast ที่เป็น error ทุกชนิดคืน duration 0 (ค้างจนกดปิด); ชนิดอื่นไม่มี duration', () => {
  const ui = loadUi();
  const failed = ui.tunnelToastFor('shop', { status: 'failed', step: 's', message: 'm', hostname: 'h.example.com', rollback: { ok: true, failed: [], orphaned: false } });
  assert.equal(failed.duration, 0);
  assert.equal(ui.removeToast('shop', false, { cloudflare: { status: 'partial', rollback: { orphaned: true } } }).duration, 0);
  assert.equal(ui.cleanupToast({ status: 'partial', failed: ['dns'] }).duration, 0);
  for (const t of [
    ui.tunnelToastFor('shop', { status: 'ok', hostname: 'h.example.com' }),
    ui.removeToast('shop', false, { cloudflare: { status: 'removed' } }),
    ui.removeToast('shop', false, { cloudflare: { status: 'kept' } }),
    ui.cleanupToast({ status: 'cleaned', failed: [] }),
  ]) assert.equal(t.duration, undefined);
});

test('apiAutoTunnel: 502 ที่มี tunnel ใน body คืนข้อมูล (ไม่โยน); error อื่นโยนข้อความของ server; 401 เด้งไป login', async () => {
  const mk = (status, body) => {
    const ctx = vm.createContext({
      window: { location: { href: '' } },
      fetch: async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }),
      encodeURIComponent, URLSearchParams,
    });
    vm.runInContext(read('js/api.js'), ctx);
    return ctx;
  };
  const tunnel = { status: 'failed', step: 'create-dns' };
  assert.deepEqual((await mk(502, { error: 'x', tunnel }).apiAutoTunnel('shop', 'h.example.com')).tunnel.step, 'create-dns');
  await assert.rejects(mk(409, { error: 'A DNS record already exists' }).apiAutoTunnel('shop', 'h.example.com'), /already exists/);
  await assert.rejects(mk(502, { error: 'no tunnel object' }).apiAutoTunnel('shop', 'h.example.com'), /no tunnel object/);
  const ctx401 = mk(401, null);
  await assert.rejects(ctx401.apiAutoTunnel('shop', 'h.example.com'), /unauthorized/);
  assert.equal(ctx401.window.location.href, '/login.html');
});

test('ไฟล์ JS ทั้งหมดใน public/js คอมไพล์ได้ (จับ syntax พังจากการแก้หลายจุด)', () => {
  for (const f of fs.readdirSync(path.join(publicDir, 'js'))) {
    if (!f.endsWith('.js')) continue;
    assert.doesNotThrow(() => new vm.Script(read(`js/${f}`), { filename: f }), f);
  }
});

// ── พฤติกรรมของ modals.js ใน vm (DOM จำลองขนาดเล็ก) ───────────────────────────────
class El {
  constructor(id) {
    this.id = id; this.hidden = false; this.checked = false; this.disabled = false; this.value = ''; this.title = '';
    this.className = ''; this.children = []; this.dataset = {}; this.style = {}; this._text = ''; this._l = {}; this._cls = new Set();
    this.classList = { add: (c) => this._cls.add(c), remove: (c) => this._cls.delete(c), contains: (c) => this._cls.has(c) };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (v === '') this.children = []; }
  addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); }
  click() { (this._l.click || []).forEach((fn) => fn()); }
  appendChild(c) { this.children.push(c); return c; }
  focus() {}
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const MODAL_ELEMENTS = [
  'removeModal', 'removeConfirmText', 'removeDeleteFiles', 'removeConfirmBtn', 'removeCloudflareRow', 'removeDeleteCloudflare',
  'removeCloudflareHost', 'removeCloudflareNote', 'createModal', 'createError', 'newBotName', 'newBotPort', 'newBotToken', 'newBotCompany',
  'createSubmitBtn', 'autoTunnelSection', 'newBotAutoTunnel', 'newBotHostnameWrap', 'newBotHostname', 'newBotHostnameHint',
  'cfOrphansBtn', 'cfOrphansModal', 'cfOrphansList', 'autoTunnelModal', 'autoTunnelTitle', 'autoTunnelError', 'autoTunnelHostname',
  'autoTunnelHint', 'autoTunnelSubmitBtn',
];

function loadModals(feature = { cloudflareAutoTunnel: false }) {
  const toasts = [];
  const calls = { apiCreateBot: [], apiRemoveBot: [], apiAutoTunnel: [], apiCleanupCfOrphan: [], loadBots: 0 };
  const el = {};
  for (const id of MODAL_ELEMENTS) el[id] = new El(id);
  const ctx = vm.createContext({
    ...el,
    document: { getElementById: (id) => el[id] || new El(id), createElement: (t) => new El(t), querySelectorAll: () => [] },
    window: {},
    botsCache: [],
    cloudflareFeature: feature,
    cfOrphansCache: [],
    autoTunnelTarget: null,
    showToast: (...a) => toasts.push(a),
    loadBots: () => { calls.loadBots += 1; },
    apiCreateBot: async (p) => { calls.apiCreateBot.push(p); return ctx.__createResult; },
    apiRemoveBot: async (...a) => { calls.apiRemoveBot.push(a); return ctx.__removeResult; },
    apiAutoTunnel: async (...a) => { calls.apiAutoTunnel.push(a); return ctx.__autoResult; },
    apiListCfOrphans: async () => ({ orphans: ctx.__orphans || [] }),
    apiCleanupCfOrphan: async (...a) => { calls.apiCleanupCfOrphan.push(a); return { status: 'cleaned', failed: [] }; },
    nextFreePortStub: 3101,
    __createResult: { id: 'x', name: 'netguard-shop', port: 3101 },
    __removeResult: { ok: true },
    __autoResult: { ok: true, tunnel: { status: 'ok', hostname: 'h.example.com' } },
    __orphans: [],
  });
  vm.runInContext(read('js/cloudflare-ui.js'), ctx);
  vm.runInContext(read('js/modals.js'), ctx);
  return { ctx, el, toasts, calls };
}

test('openRemoveModal: บอทที่ไม่มี cloudflare state → ไม่แสดงส่วน Cloudflare เลย', () => {
  const { ctx, el } = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  ctx.botsCache = [{ id: 'a1', name: 'netguard-shop', tunnel: { exists: false } }];
  ctx.openRemoveModal('a1', 'shop');
  assert.equal(el.removeCloudflareRow.hidden, true);
  assert.equal(el.removeCloudflareNote.hidden, true);
  assert.equal(el.removeDeleteCloudflare.checked, false);
});

test('openRemoveModal: บอทมี state + flag เปิด → แสดงช่องลบ Cloudflare และติ๊กไว้ให้เป็นค่าเริ่มต้น (ผู้ใช้ปลดได้)', () => {
  const { ctx, el } = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  ctx.botsCache = [{ id: 'a1', name: 'netguard-shop', tunnel: { exists: true }, cloudflare: { hostname: 'shop.example.com', step: 'complete' } }];
  ctx.openRemoveModal('a1', 'shop');
  assert.equal(el.removeCloudflareRow.hidden, false);
  assert.equal(el.removeDeleteCloudflare.checked, true);
  assert.equal(el.removeCloudflareHost.textContent, 'shop.example.com');
  assert.equal(el.removeCloudflareNote.hidden, true);
});

test('openRemoveModal: บอทมี state แต่ flag ปิด → ไม่มีช่องลบ มีข้อความอธิบายแทน', () => {
  const { ctx, el } = loadModals({ cloudflareAutoTunnel: false });
  ctx.botsCache = [{ id: 'a1', name: 'netguard-shop', tunnel: { exists: true }, cloudflare: { hostname: 'shop.example.com', step: 'complete' } }];
  ctx.openRemoveModal('a1', 'shop');
  assert.equal(el.removeCloudflareRow.hidden, true);
  assert.equal(el.removeDeleteCloudflare.checked, false);
  assert.equal(el.removeCloudflareNote.hidden, false);
  assert.match(el.removeCloudflareNote.textContent, /shop\.example\.com/);
});

test('submitRemoveBot: ส่ง deleteCloudflare ตามช่องติ๊กเฉพาะบอทที่มี state; บอทอื่น undefined; toast ตามผลลัพธ์', async () => {
  const { ctx, el, calls, toasts } = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  ctx.botsCache = [
    { id: 'a1', name: 'netguard-shop', cloudflare: { hostname: 'shop.example.com' } },
    { id: 'b2', name: 'netguard-plain' },
  ];
  ctx.removeTarget = { id: 'a1', name: 'shop' };
  el.removeDeleteCloudflare.checked = true;
  ctx.__removeResult = { ok: true, cloudflare: { status: 'removed' } };
  await ctx.submitRemoveBot();
  ctx.removeTarget = { id: 'a1', name: 'shop' };
  el.removeDeleteCloudflare.checked = false;
  await ctx.submitRemoveBot();
  ctx.removeTarget = { id: 'b2', name: 'plain' };
  el.removeDeleteCloudflare.checked = true; // ค่าค้างจากครั้งก่อนต้องไม่รั่วไปกับบอทที่ไม่มี state
  ctx.__removeResult = { ok: true };
  await ctx.submitRemoveBot();
  assert.deepEqual(calls.apiRemoveBot.map((a) => a[2]), [true, false, undefined]);
  assert.equal(toasts[0][1], 'success');
  assert.match(toasts[0][0], /Cloudflare/);
  assert.equal(toasts[2][0], 'ลบ bot "plain" สำเร็จ');
});

test('updateAutoTunnelUi: flag ปิด → ซ่อนส่วนใหม่ ช่อง token ใช้ได้; flag เปิดแต่ไม่ติ๊ก → เห็นช่องติ๊กอย่างเดียว; ติ๊กแล้ว → เห็น hostname และช่อง token ถูกปิด', () => {
  const off = loadModals({ cloudflareAutoTunnel: false });
  off.el.newBotAutoTunnel.checked = true; // แม้ค้างติ๊กไว้
  off.ctx.updateAutoTunnelUi();
  assert.equal(off.el.autoTunnelSection.hidden, true);
  assert.equal(off.el.newBotHostnameWrap.hidden, true);
  assert.equal(off.el.newBotToken.disabled, false);

  const on = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  on.ctx.updateAutoTunnelUi();
  assert.equal(on.el.autoTunnelSection.hidden, false);
  assert.equal(on.el.newBotHostnameWrap.hidden, true);
  assert.equal(on.el.newBotToken.disabled, false);
  on.el.newBotAutoTunnel.checked = true;
  on.ctx.updateAutoTunnelUi();
  assert.equal(on.el.newBotHostnameWrap.hidden, false);
  assert.equal(on.el.newBotToken.disabled, true);
  assert.match(on.el.newBotHostnameHint.textContent, /example\.com/);
});

test('submitCreateBot: flag ปิด → payload เดิม (ไม่มี autoTunnel) และไม่มี toast ของ tunnel', async () => {
  const { ctx, el, calls, toasts } = loadModals({ cloudflareAutoTunnel: false });
  el.newBotName.value = 'shop';
  el.newBotPort.value = '3101';
  el.newBotCompany.value = 'ACME';
  await ctx.submitCreateBot();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.apiCreateBot)), [{ name: 'shop', port: 3101, companyName: 'ACME' }]);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], 'success');
});

test('submitCreateBot: ติ๊ก auto → ส่ง autoTunnel+hostname ไม่ส่ง token; tunnel ล้ม → toast สำเร็จของบอท + toast error ค้าง (duration 0); tunnel ok → toast success', async () => {
  const { ctx, el, calls, toasts } = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  el.newBotName.value = 'shop';
  el.newBotPort.value = '3101';
  el.newBotAutoTunnel.checked = true;
  el.newBotHostname.value = 'Shop.example.com';
  el.newBotToken.value = 'should_not_be_sent_0123456789abcdef';
  ctx.__createResult = { id: 'x', name: 'netguard-shop', port: 3101, tunnel: { status: 'failed', step: 'create-dns', message: 'HTTP 400', hostname: 'shop.example.com', rollback: { ok: true, failed: [], orphaned: false } } };
  await ctx.submitCreateBot();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.apiCreateBot[0])), { name: 'shop', port: 3101, autoTunnel: true, hostname: 'shop.example.com' });
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0][1], 'success');
  assert.equal(toasts[1][1], 'error');
  assert.equal(toasts[1][2], 0);
  assert.match(toasts[1][0], /create-dns/);

  toasts.length = 0;
  ctx.__createResult = { id: 'x', name: 'netguard-shop', port: 3101, tunnel: { status: 'ok', hostname: 'shop.example.com' } };
  await ctx.submitCreateBot();
  assert.deepEqual(toasts.map((t) => t[1]), ['success', 'success']);
});

test('submitCreateBot: ติ๊ก auto แต่ hostname ผิด → แสดง error ในฟอร์มและไม่เรียก API', async () => {
  const { ctx, el, calls } = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  el.newBotName.value = 'shop';
  el.newBotPort.value = '3101';
  el.newBotAutoTunnel.checked = true;
  el.newBotHostname.value = 'shop.other.com';
  await ctx.submitCreateBot();
  assert.deepEqual(calls.apiCreateBot, []);
  assert.ok(el.createError.classList.contains('show'));
  assert.match(el.createError.textContent, /example\.com/);
});

test('renderCfOrphans: ใส่ข้อความด้วย textContent (สตริงอันตรายไม่ถูกตีความ), ปุ่ม "ล้าง" ใช้ได้เฉพาะเมื่อ flag เปิด, กดแล้วเรียก API ด้วย tunnelId', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const entry = { botName: 'shop', hostname: 'shop.example.com', tunnelId: '11111111-2222-4333-8444-555555555555', leftovers: ['tunnel'], reason: hostile };

  const off = loadModals({ cloudflareAutoTunnel: false });
  off.ctx.cfOrphansCache = [entry];
  off.ctx.renderCfOrphans();
  const offRow = off.el.cfOrphansList.children[0];
  const offBtn = offRow.children[1];
  assert.equal(offBtn.disabled, true);
  assert.ok(offBtn.title);
  assert.equal(off.el.cfOrphansList.innerHTML, undefined);
  assert.equal(offRow.children[0].children[2].textContent, hostile);

  const on = loadModals({ cloudflareAutoTunnel: true, cloudflareZone: 'example.com' });
  on.ctx.cfOrphansCache = [entry];
  on.ctx.renderCfOrphans();
  const btn = on.el.cfOrphansList.children[0].children[1];
  assert.equal(btn.disabled, false);
  btn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(on.calls.apiCleanupCfOrphan, [[entry.tunnelId]]);
  assert.equal(on.toasts[0][1], 'success');
});

test('renderCfOrphans: ไม่มีรายการ → ข้อความว่าง', () => {
  const { ctx, el } = loadModals();
  ctx.cfOrphansCache = [];
  ctx.renderCfOrphans();
  assert.equal(el.cfOrphansList.children.length, 1);
  assert.match(el.cfOrphansList.children[0].textContent, /ไม่มี/);
});

test('refreshCfOrphans: แสดงปุ่มพร้อมจำนวนเมื่อมีรายการ ซ่อนเมื่อไม่มี หรือเมื่อโหลดไม่ได้', async () => {
  const { ctx, el } = loadModals();
  ctx.__orphans = [{ botName: 'a', hostname: 'a.example.com', tunnelId: 'x', leftovers: [] }, { botName: 'b', hostname: 'b.example.com', tunnelId: 'y', leftovers: [] }];
  await ctx.refreshCfOrphans();
  assert.equal(el.cfOrphansBtn.hidden, false);
  assert.match(el.cfOrphansBtn.textContent, /\(2\)/);
  ctx.__orphans = [];
  await ctx.refreshCfOrphans();
  assert.equal(el.cfOrphansBtn.hidden, true);
  ctx.apiListCfOrphans = async () => { throw new Error('down'); };
  ctx.__orphans = [{ botName: 'a' }];
  await ctx.refreshCfOrphans();
  assert.equal(el.cfOrphansBtn.hidden, true);
});

test('apiCleanupCfOrphan: tunnelId ถูก encode ใน URL', async () => {
  const { ctx, calls } = loadApi();
  await ctx.apiCleanupCfOrphan('a/b');
  assert.equal(calls[0].url, '/api/cloudflare/orphans/a%2Fb/cleanup');
});

test('ข้อความตรวจ hostname บอกเหตุผลเฉพาะ: zone ไม่ทราบ / ไม่กรอก / rollback orphaned ชี้ไปที่ปุ่มรายการค้าง (ไม่ใช่ข้อความ log)', () => {
  const ui = loadUi();
  assert.match(ui.autoHostnameProblem('shop.example.com', ''), /zone/);
  assert.match(ui.autoHostnameProblem('', 'example.com'), /กรอก/);
  const t = ui.tunnelToastFor('shop', { status: 'failed', step: 's', message: 'm', hostname: 'h', rollback: { ok: false, failed: ['tunnel'], orphaned: true } });
  assert.match(t.text, /ปุ่ม "Cloudflare ค้าง"/);
  assert.doesNotMatch(t.text, /log ของ Manager/);
});
