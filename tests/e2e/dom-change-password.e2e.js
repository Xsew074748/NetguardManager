'use strict';
// ทดสอบเบราว์เซอร์จริง (Edge headless + puppeteer-core) ของ modal เปลี่ยนรหัสผ่าน กับ index.js ตัวจริง
// ไม่อยู่ในชุด `npm test` (puppeteer-core ไม่ได้เป็น dependency ของโปรเจกต์) รันเอง:
//   PUPPETEER_CORE=<โฟลเดอร์ node_modules/puppeteer-core> [EDGE_PATH=<msedge.exe>] node --test tests/e2e/dom-change-password.e2e.js
// ข้อมูลอยู่ในโฟลเดอร์ temp; รหัสทดสอบสุ่มขึ้นเอง; ปิด server และ Edge ทุกครั้งเมื่อจบ

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let puppeteer = null;
try { puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core'); } catch { /* ไม่มี */ }
const SKIP = !puppeteer ? 'ไม่พบ puppeteer-core (ตั้ง PUPPETEER_CORE)'
  : !fs.existsSync(EDGE) ? 'ไม่พบ Edge'
    : fs.existsSync('/var/run/docker.sock') ? 'พบ docker.sock จริง' : false;

const rnd = (tag) => `${tag}-${crypto.randomBytes(9).toString('hex')}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let tmp; let child; let port; let db; let browser; let page;
let output = '';
let pwCurrent = rnd('s').slice(0, 8); // สั้นกว่า 12 → ติดธง weak → เห็น banner รหัสอ่อน
let passwordRequests = []; // คำขอ POST /api/auth/password ที่ browser ส่งจริง

const base = () => `http://127.0.0.1:${port}`;
const auditRows = (action) => db.prepare('SELECT result, detail FROM audit_log WHERE action = ? ORDER BY id').all(action)
  .map((r) => ({ result: r.result, detail: r.detail ? JSON.parse(r.detail) : {} }));

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(100);
  }
}

async function login() {
  await page.goto(`${base()}/login.html`);
  await page.type('#password', pwCurrent);
  await Promise.all([page.waitForNavigation(), page.click('#submitBtn')]);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.waitForSelector('#changePasswordBtn');
}

const modalOpen = () => page.$eval('#changePasswordModal', (el) => el.classList.contains('show'));
const errorText = () => page.$eval('#changePasswordError', (el) => (el.classList.contains('show') ? el.textContent : ''));
const toasts = () => page.$$eval('.toast', (els) => els.map((e) => ({ cls: e.className, text: e.textContent })));

async function openFromSidebar() {
  await page.click('#changePasswordBtn');
  assert.ok(await modalOpen(), 'modal ต้องเปิด');
}

async function fill(cur, nxt, cfm) {
  await page.type('#pwCurrent', cur);
  await page.type('#pwNew', nxt);
  await page.type('#pwConfirm', cfm);
}

test.before(async () => {
  if (SKIP) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-dom-'));
  fs.mkdirSync(path.join(tmp, 'bots'));
  port = await freePort();
  const dbPath = path.join(tmp, 'stats.db');
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'index.js')], {
    cwd: tmp,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: dbPath, AUTH_FILE: path.join(tmp, 'auth.json'),
      BOTS_ROOT: path.join(tmp, 'bots'), POLLER_BOTS: 'no-such-bot', MANAGER_PASSWORD_HASH: sha256(pwCurrent),
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server ไม่ขึ้น')), 20000);
    const check = setInterval(() => { if (output.includes('listening on port')) { clearInterval(check); clearTimeout(timer); resolve(); } }, 50);
    child.once('exit', (code) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server จบเอง ${code}`)); });
  });
  db = new Database(dbPath, { readonly: true });
  browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, userDataDir: path.join(tmp, 'edge-profile'),
    args: ['--no-first-run', '--disable-gpu', '--no-sandbox'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('request', (r) => { if (r.url().includes('/api/auth/password') && r.method() === 'POST') passwordRequests.push(r.url()); });
  page.on('pageerror', (e) => { output += `\n[pageerror] ${e.message}`; });
  await login();
});

test.after(async () => {
  try { if (browser) await browser.close(); } catch { /* ปิดแล้ว */ }
  try { if (db) db.close(); } catch { /* ปิดแล้ว */ }
  if (child && child.exitCode === null) {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); setTimeout(resolve, 6000).unref(); });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('DOM: เปิด modal จากแถบข้าง และจาก banner รหัสอ่อน', { skip: SKIP }, async () => {
  assert.equal(await page.$eval('#weakPasswordBanner', (el) => el.hidden), false, 'banner รหัสอ่อนต้องเห็น');
  await openFromSidebar();
  await page.click('#changePasswordCancelBtn');
  assert.equal(await modalOpen(), false);
  await page.click('#weakPasswordChangeBtn');
  assert.ok(await modalOpen());
  await page.click('#changePasswordCancelBtn');
  assert.equal(await modalOpen(), false);
  assert.equal(passwordRequests.length, 0);
});

test('DOM: ฟอร์มไม่ผ่านการตรวจฝั่ง browser → ไม่ส่งคำขอ แสดงข้อความ', { skip: SKIP }, async () => {
  const before = auditRows('auth.password-change').length;
  await openFromSidebar();
  await fill(pwCurrent, 'short', 'short');
  await page.click('#changePasswordSubmitBtn');
  assert.match(await errorText(), /12/);
  await sleep(500);
  assert.equal(passwordRequests.length, 0);
  assert.equal(auditRows('auth.password-change').length, before);
  await page.click('#changePasswordCancelBtn');
});

test('DOM: รหัสเดิมผิด กดปุ่ม → ไม่เด้งไป login, แสดงข้อความในฟอร์ม, audit fail/bad-current', { skip: SKIP }, async () => {
  const before = auditRows('auth.password-change').length;
  const reqs = passwordRequests.length;
  await openFromSidebar();
  const nxt = rnd('new');
  await fill(rnd('wrong'), nxt, nxt);
  await page.click('#changePasswordSubmitBtn');
  assert.ok(await waitFor(async () => (await errorText()) !== ''), 'ต้องมีข้อความผิดพลาดในฟอร์ม');
  assert.equal(new URL(page.url()).pathname, '/', 'ต้องไม่เด้งไป login');
  assert.equal(passwordRequests.length, reqs + 1);
  const rows = auditRows('auth.password-change');
  assert.equal(rows.length, before + 1);
  assert.deepEqual([rows.at(-1).result, rows.at(-1).detail.reason], ['fail', 'bad-current']);
  assert.equal(await modalOpen(), true, 'modal ต้องยังเปิด');
  await page.click('#changePasswordCancelBtn');
});

test('DOM: รหัสเดิมผิด กด Enter ในช่องรหัส → ต้องส่งเหมือนกดปุ่ม (ไม่เด้งไป login, audit fail/bad-current)', { skip: SKIP }, async () => {
  const before = auditRows('auth.password-change').length;
  const reqs = passwordRequests.length;
  await openFromSidebar();
  const nxt = rnd('new');
  await fill(rnd('wrong'), nxt, nxt);
  await page.keyboard.press('Enter');
  await waitFor(() => passwordRequests.length > reqs, 3000);
  assert.equal(passwordRequests.length, reqs + 1, 'Enter ต้องทำให้ browser ส่งคำขอ');
  assert.ok(await waitFor(async () => (await errorText()) !== ''), 'ต้องมีข้อความผิดพลาดในฟอร์ม');
  assert.equal(new URL(page.url()).pathname, '/');
  const rows = auditRows('auth.password-change');
  assert.equal(rows.length, before + 1);
  assert.deepEqual([rows.at(-1).result, rows.at(-1).detail.reason], ['fail', 'bad-current']);
  await page.click('#changePasswordCancelBtn');
});

test('DOM: เปลี่ยนสำเร็จด้วยการกด Enter → toast สำเร็จ, modal ปิด, banner เปลี่ยน, audit ok', { skip: SKIP }, async () => {
  const before = auditRows('auth.password-change').length;
  const next = rnd('enter');
  await openFromSidebar();
  const reqsBefore = passwordRequests.length;
  await fill(pwCurrent, next, next);
  await Promise.all([page.keyboard.press('Enter'), page.keyboard.press('Enter')]); // กดซ้ำเร็วๆ ต้องส่งแค่ครั้งเดียว
  assert.ok(await waitFor(async () => (await toasts()).some((t) => /success/.test(t.cls))), 'ต้องมี toast สำเร็จ');
  assert.equal(await modalOpen(), false);
  assert.equal(passwordRequests.length, reqsBefore + 1, 'Enter ซ้ำต้องไม่ส่งซ้ำ');
  assert.equal(await page.$eval('#weakPasswordBanner', (el) => el.hidden), true);
  assert.equal(await page.$eval('#envHashStaleBanner', (el) => el.hidden), false);
  const rows = auditRows('auth.password-change');
  assert.equal(rows.length, before + 1);
  assert.equal(rows.at(-1).result, 'ok');
  pwCurrent = next;
});

test('DOM: เปลี่ยนสำเร็จด้วยการกดปุ่ม → toast สำเร็จ, audit ok, ออกแล้ว login ซ้ำด้วยรหัสใหม่ได้', { skip: SKIP }, async () => {
  const before = auditRows('auth.password-change').length;
  const next = rnd('button');
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); });
  await openFromSidebar();
  await fill(pwCurrent, next, next);
  await page.click('#changePasswordSubmitBtn');
  assert.ok(await waitFor(async () => (await toasts()).some((t) => /success/.test(t.cls))), 'ต้องมี toast สำเร็จ');
  assert.equal(await modalOpen(), false);
  const rows = auditRows('auth.password-change');
  assert.equal(rows.length, before + 1);
  assert.equal(rows.at(-1).result, 'ok');
  pwCurrent = next;
  // ออกจากระบบแล้ว login ด้วยรหัสใหม่
  await page.click('#logoutBtn');
  await waitFor(() => new URL(page.url()).pathname === '/login.html');
  await login();
});
