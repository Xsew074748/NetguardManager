'use strict';
// middleware/csrf-guard.js — กัน CSRF สำหรับ route ที่เปลี่ยนสถานะสำคัญ (ใช้ซ้ำได้ ยังไม่ครอบทุก route)
//  ชั้น 1: ต้องมี header X-Requested-With (ฟอร์มข้ามเว็บ/ลิงก์ใส่ header นี้ไม่ได้โดยไม่ผ่าน CORS preflight)
//  ชั้น 2: ถ้ามี Origin ต้องชี้ host เดียวกับ Host ของคำขอ (หรือ X-Forwarded-Host เมื่อผ่าน tunnel/proxy)
//          ไม่เทียบ Origin อย่างเดียว: Manager อยู่หลัง Cloudflare tunnel ค่า Origin ที่ browser ส่งคือโดเมนภายนอก ไม่ใช่ localhost

const test = require('node:test');
const assert = require('node:assert/strict');

const { requireSameOrigin } = require('../middleware/csrf-guard');

function run(headers) {
  const mw = requireSameOrigin();
  const req = { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  let status = null; let body = null; let nexted = false;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  mw(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

const XRW = { 'X-Requested-With': 'fetch' };

test('ไม่มี X-Requested-With → 403 (แม้ Origin จะตรง)', () => {
  const r = run({ Host: 'manager.example.org', Origin: 'https://manager.example.org' });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
  assert.equal(typeof r.body.error, 'string');
});

test('มี X-Requested-With และไม่มี Origin (เช่น curl/same-origin บาง browser) → ผ่าน', () => {
  assert.equal(run({ Host: 'localhost:8080', ...XRW }).nexted, true);
});

test('Origin ตรงกับ Host (รวมพอร์ต) → ผ่าน', () => {
  assert.equal(run({ Host: 'localhost:8080', Origin: 'http://localhost:8080', ...XRW }).nexted, true);
  assert.equal(run({ Host: 'Manager.Example.org', Origin: 'https://manager.example.org', ...XRW }).nexted, true);
});

test('Origin คนละโดเมน → 403', () => {
  const r = run({ Host: 'manager.example.org', Origin: 'https://evil.example.net', ...XRW });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
});

test('Origin โดเมนเดียวกันแต่คนละพอร์ต → 403', () => {
  assert.equal(run({ Host: 'localhost:8080', Origin: 'http://localhost:9999', ...XRW }).status, 403);
});

test('Origin ที่ host เป็นคำนำหน้า/ต่อท้ายของ Host (หลอกด้วยโดเมนที่ขึ้นต้นเหมือน) → 403', () => {
  assert.equal(run({ Host: 'manager.example.org', Origin: 'https://manager.example.org.evil.net', ...XRW }).status, 403);
  assert.equal(run({ Host: 'manager.example.org', Origin: 'https://evil-manager.example.org', ...XRW }).status, 403);
});

test('Origin: null / ไม่ใช่ URL → 403', () => {
  assert.equal(run({ Host: 'localhost:8080', Origin: 'null', ...XRW }).status, 403);
  assert.equal(run({ Host: 'localhost:8080', Origin: 'not a url', ...XRW }).status, 403);
});

test('หลัง proxy/tunnel: Host ภายใน แต่ X-Forwarded-Host ตรงกับ Origin → ผ่าน', () => {
  const r = run({ Host: 'manager:8080', 'X-Forwarded-Host': 'manager.example.org', Origin: 'https://manager.example.org', ...XRW });
  assert.equal(r.nexted, true);
});

test('X-Forwarded-Host หลายค่า ใช้ค่าแรก; ค่าอื่นไม่ช่วยให้ผ่าน', () => {
  assert.equal(run({ Host: 'manager:8080', 'X-Forwarded-Host': 'manager.example.org, evil.net', Origin: 'https://manager.example.org', ...XRW }).nexted, true);
  assert.equal(run({ Host: 'manager:8080', 'X-Forwarded-Host': 'manager.example.org, evil.net', Origin: 'https://evil.net', ...XRW }).status, 403);
});

test('ไม่มี Host เลยแต่มี Origin → 403 (เทียบอะไรไม่ได้)', () => {
  assert.equal(run({ Origin: 'https://manager.example.org', ...XRW }).status, 403);
});

test('ค่า X-Requested-With ว่าง → 403', () => {
  assert.equal(run({ Host: 'localhost:8080', 'X-Requested-With': '' }).status, 403);
});

test('Origin ที่ไม่ใช่ http/https (เช่น ftp://) → 403 แม้ host จะตรง', () => {
  assert.equal(run({ Host: 'manager.example.org', Origin: 'ftp://manager.example.org', ...XRW }).status, 403);
  assert.equal(run({ Host: 'manager.example.org', Origin: 'chrome-extension://manager.example.org', ...XRW }).status, 403);
});

test('เรียก onReject พร้อมเหตุผล และ onReject ที่ throw ไม่ทำให้ตอบ 403 ไม่ได้', () => {
  const reasons = [];
  const mw = requireSameOrigin({ onReject: (req, reason) => { reasons.push(reason); throw new Error('boom'); } });
  const mk = (headers) => ({ req: { headers }, res: { code: null, status(c) { this.code = c; return this; }, json() { return this; } } });
  const a = mk({ host: 'h' }); mw(a.req, a.res, () => {});
  const b = mk({ host: 'h', origin: 'http://x', 'x-requested-with': 'fetch' }); mw(b.req, b.res, () => {});
  assert.deepEqual(reasons, ['missing-header', 'origin-mismatch']);
  assert.equal(a.res.code, 403);
  assert.equal(b.res.code, 403);
});
