'use strict';
// public/login.html — ช่องรหัสผ่านตอน login ต้องบอก browser ว่าเป็น "รหัสผ่านปัจจุบัน" (ให้ตัวจัดการรหัสผ่านเติมได้)
// ทดสอบระดับซอร์ส (รูปแบบของแท็ก) ไม่มี DOM จริง

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
const pwInputs = html.match(/<input\b[^>]*type="password"[^>]*>/g) || [];

test('login.html มีช่อง password หนึ่งช่อง', () => {
  assert.equal(pwInputs.length, 1);
  assert.match(pwInputs[0], /id="password"/);
});

test('login.html: autocomplete ของช่องรหัสเป็น current-password ไม่ใช่ new-password', () => {
  assert.match(pwInputs[0], /autocomplete="current-password"/);
  assert.doesNotMatch(pwInputs[0], /new-password/);
});

test('login.html: ช่องรหัสยัง required และ autofocus เหมือนเดิม', () => {
  assert.match(pwInputs[0], /\brequired\b/);
  assert.match(pwInputs[0], /\bautofocus\b/);
});

test('login.html: ฟอร์ม login ยังส่งไป /api/auth/login ด้วย POST JSON', () => {
  assert.match(html, /fetch\('\/api\/auth\/login'/);
  assert.match(html, /method:\s*'POST'/);
});
