'use strict';
// public/js/password-form.js — ตรวจฟอร์มเปลี่ยนรหัสฝั่ง browser (กฎต้องตรงกับ services/password.js validateNewPassword)
// + ตรวจโครงสร้าง HTML/JS ที่ผูกปุ่มและ modal (ทดสอบระดับซอร์ส ไม่มี DOM จริง)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(publicDir, p), 'utf8').replace(/\r\n/g, '\n'); // CRLF → LF (modals.js เป็น CRLF)
const rnd = (tag) => `${tag}-${crypto.randomBytes(9).toString('hex')}`;

function loadForm() {
  const ctx = vm.createContext({});
  vm.runInContext(read('js/password-form.js'), ctx);
  return ctx;
}

test('validatePasswordForm: ช่องว่าง/ไม่กรอก → ข้อความ', () => {
  const { validatePasswordForm } = loadForm();
  assert.ok(validatePasswordForm({ current: '', next: rnd('n'), confirm: rnd('n') }));
  assert.ok(validatePasswordForm({ current: rnd('c'), next: '', confirm: '' }));
});

test('validatePasswordForm: รหัสใหม่สั้นกว่า 12 → ข้อความ', () => {
  const { validatePasswordForm } = loadForm();
  const n = rnd('n').slice(0, 11);
  assert.ok(validatePasswordForm({ current: rnd('c'), next: n, confirm: n }));
});

test('validatePasswordForm: ตัวอักษรตัวเดียวซ้ำทั้งสาย → ข้อความ', () => {
  const { validatePasswordForm } = loadForm();
  assert.ok(validatePasswordForm({ current: rnd('c'), next: 'z'.repeat(20), confirm: 'z'.repeat(20) }));
});

test('validatePasswordForm: ยืนยันไม่ตรง → ข้อความ', () => {
  const { validatePasswordForm } = loadForm();
  assert.ok(validatePasswordForm({ current: rnd('c'), next: rnd('a'), confirm: rnd('b') }));
});

test('validatePasswordForm: ซ้ำรหัสเดิม → ข้อความ', () => {
  const { validatePasswordForm } = loadForm();
  const c = rnd('same');
  assert.ok(validatePasswordForm({ current: c, next: c, confirm: c }));
});

test('validatePasswordForm: ยาวเกิน 1024 → ข้อความ', () => {
  const { validatePasswordForm } = loadForm();
  const n = `${rnd('n')}${'q'.repeat(1100)}`;
  assert.ok(validatePasswordForm({ current: rnd('c'), next: n, confirm: n }));
});

test('validatePasswordForm: ถูกต้อง → null', () => {
  const { validatePasswordForm } = loadForm();
  const n = rnd('new');
  assert.equal(validatePasswordForm({ current: rnd('cur'), next: n, confirm: n }), null);
});

test('กฎฝั่ง browser เท่ากับกฎฝั่ง server (ตัวเลขขั้นต่ำ/สูงสุดตรงกัน)', () => {
  const { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = vm.runInContext('({ PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH })', loadForm()); // const ระดับบนสุดไม่ติดเป็น property ของ context
  const server = require('../services/password');
  assert.equal(PASSWORD_MIN_LENGTH, server.MIN_PASSWORD_LENGTH);
  assert.equal(PASSWORD_MAX_LENGTH, server.MAX_PASSWORD_LENGTH);
});

// ── ระดับซอร์ส: HTML / API wrapper / การผูกปุ่ม ──────────────────────────────────
test('index.html: มี modal เปลี่ยนรหัส 3 ช่อง ชนิด password และ autocomplete ถูกต้อง', () => {
  const html = read('index.html');
  assert.match(html, /id="changePasswordModal"/);
  assert.match(html, /<input[^>]*id="pwCurrent"[^>]*type="password"[^>]*autocomplete="current-password"|<input[^>]*type="password"[^>]*id="pwCurrent"[^>]*autocomplete="current-password"/);
  for (const id of ['pwNew', 'pwConfirm']) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*autocomplete="new-password"`));
  }
  assert.match(html, /id="changePasswordBtn"/);
  assert.match(html, /<script src="js\/password-form\.js"><\/script>/);
});

test('index.html: banner รหัสอ่อนมีปุ่มเปิด modal เดียวกัน และมี banner .env ล้าสมัย (ซ่อนเริ่มต้น)', () => {
  const html = read('index.html');
  assert.match(html, /id="weakPasswordBanner"[\s\S]*?id="weakPasswordChangeBtn"/);
  assert.match(html, /id="envHashStaleBanner"[^>]*hidden/);
  assert.match(html, /MANAGER_PASSWORD_HASH/);
});

test('password-form.js ถูกโหลดก่อน modals.js / app.js', () => {
  const html = read('index.html');
  const i = html.indexOf('js/password-form.js');
  assert.ok(i > 0 && i < html.indexOf('js/modals.js') && i < html.indexOf('js/app.js'));
});

test('api.js: apiChangePassword ส่ง POST /api/auth/password พร้อม X-Requested-With และไม่ใส่รหัสใน URL', () => {
  const src = read('js/api.js');
  const m = src.match(/function apiChangePassword[\s\S]*?\n}\n/);
  assert.ok(m, 'ต้องมี apiChangePassword');
  assert.match(m[0], /\/api\/auth\/password/);
  assert.match(m[0], /method:\s*'POST'/);
  assert.match(m[0], /X-Requested-With/);
  assert.match(m[0], /JSON\.stringify/);
  assert.doesNotMatch(m[0], /\?[a-z]+=\$\{/);
});

test('modals.js: submit เปลี่ยนรหัสไม่ส่งรหัสออกทาง log/console และล้างช่องหลังสำเร็จ', () => {
  const src = read('js/modals.js');
  const m = src.match(/async function submitChangePassword[\s\S]*?\n}\n/);
  assert.ok(m, 'ต้องมี submitChangePassword');
  assert.doesNotMatch(m[0], /console\.(log|info|warn|error)/);
  assert.match(m[0], /validatePasswordForm/);
  assert.match(m[0], /clearPasswordFields\(\)/); // ล้างช่องหลังสำเร็จ
  const clear = src.match(/function clearPasswordFields[\s\S]*?\n}\n/);
  assert.ok(clear, 'ต้องมี clearPasswordFields');
  assert.match(clear[0], /\.value\s*=\s*''/);
  const close = src.match(/function closeChangePasswordModal[\s\S]*?\n}\n/);
  assert.ok(close && /clearPasswordFields\(\)/.test(close[0]), 'ปิด modal ต้องล้างช่อง');
  const open = src.match(/function openChangePasswordModal[\s\S]*?\n}\n/);
  assert.ok(open && /clearPasswordFields\(\)/.test(open[0]), 'เปิด modal ต้องล้างช่อง');
});

test('app/modals ผูกปุ่ม changePasswordBtn และ weakPasswordChangeBtn', () => {
  const src = read('js/modals.js') + read('js/app.js') + read('js/audit-ui.js');
  assert.match(src, /getElementById\('changePasswordBtn'\)/);
  assert.match(src, /getElementById\('weakPasswordChangeBtn'\)/);
});

test('audit-ui: แสดง banner .env ล้าสมัยจาก envHashStale ของ /status', () => {
  const src = read('js/audit-ui.js');
  assert.match(src, /envHashStale/);
  assert.match(src, /envHashStaleBanner/);
});

test('audit filter มีตัวเลือก auth.* อยู่แล้วและครอบคลุม auth.password-change', () => {
  assert.match(read('index.html'), /<option value="auth\.">/);
});

test('validatePasswordForm: ยาว 12 พอดีผ่าน, 11 ไม่ผ่าน; emoji ซ้ำทั้งสายไม่ผ่าน', () => {
  const { validatePasswordForm } = loadForm();
  const ok = 'abcdefghijkl';
  assert.equal(validatePasswordForm({ current: rnd('c'), next: ok, confirm: ok }), null);
  assert.ok(validatePasswordForm({ current: rnd('c'), next: ok.slice(0, 11), confirm: ok.slice(0, 11) }));
  assert.ok(validatePasswordForm({ current: rnd('c'), next: '😀'.repeat(13), confirm: '😀'.repeat(13) }));
});
