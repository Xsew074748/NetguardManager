'use strict';
// ทดสอบ showToast (public/js/render.js) ด้วย DOM จำลองขนาดเล็ก — ไม่ต้องใช้เบราว์เซอร์
// ครอบคลุม: duration 0 ค้างไม่ปิดเอง, ปุ่ม ×, ลิมิต 4 ตัวค้าง (ตัดตัวเก่าสุด), ข้อความซ้ำไม่สร้างซ้ำ,
// toast ปกติยังปิดเองตามเวลา, ไม่มีแถบ progress เมื่อค้าง
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.dataset = {}; this.style = {};
    this.attrs = {}; this.listeners = {}; this.textContent = ''; this._cls = new Set(); this.type = '';
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._cls;
    return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn()); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  _all(out = []) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this._all().filter((e) => e._cls.has(cls));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function loadRender() {
  const container = new FakeEl('div');
  const timers = [];
  const sandbox = {
    document: { createElement: (t) => new FakeEl(t) },
    toastContainer: container,
    window: { matchMedia: () => ({ matches: false }) },
    // setTimeout จำลอง: เก็บไว้แล้วสั่งเดินเวลาเอง
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.done = true; },
    performance: { now: () => 0 }, requestAnimationFrame: () => {},
    console,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'render.js'), 'utf8');
  vm.runInContext(src, sandbox);
  // dismissToast รอ animationend เพื่อ remove จริง — ในเทสต์ยิง event นั้นเอง
  const flush = () => {
    for (const el of container._all()) {
      if (el._cls.has('toast-out')) (el.listeners.animationend || []).forEach((fn) => fn());
    }
  };
  return { showToast: sandbox.showToast, container, timers, flush };
}
const toasts = (c) => c.children.filter((e) => e._cls.has('toast'));
const runTimers = (timers) => timers.filter((t) => !t.done).forEach((t) => { t.done = true; t.fn(); });

test('toast ปกติ (ค่าเริ่มต้น) ปิดเองหลังหมดเวลา และมีแถบ progress + ปุ่ม ×', () => {
  const { showToast, container, timers, flush } = loadRender();
  const el = showToast('บันทึกสำเร็จ', 'success');
  assert.equal(toasts(container).length, 1);
  assert.ok(el.querySelector('.toast-progress'), 'ต้องมีแถบ progress');
  assert.ok(el.querySelector('.toast-close'), 'ต้องมีปุ่ม ×');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 4000);
  runTimers(timers); flush();
  assert.equal(toasts(container).length, 0, 'ต้องหายเองหลัง 4 วิ');
});

test('duration=0 ค้างไม่ปิดเอง ไม่มี progress มีปุ่ม × และ role=alert', () => {
  const { showToast, container, timers } = loadRender();
  const el = showToast('ล้มเหลว', 'error', 0);
  assert.equal(timers.length, 0, 'ต้องไม่ตั้ง timer ปิดเอง');
  assert.equal(el.querySelector('.toast-progress'), null);
  assert.ok(el.querySelector('.toast-close'));
  assert.equal(el.attrs.role, 'alert');
  assert.equal(toasts(container).length, 1);
});

test('กดปุ่ม × ปิด toast ที่ค้างได้', () => {
  const { showToast, container, flush } = loadRender();
  const el = showToast('ล้มเหลว', 'error', 0);
  el.querySelector('.toast-close').click();
  flush();
  assert.equal(toasts(container).length, 0);
  // ปิดแล้วข้อความเดิมสร้างใหม่ได้
  showToast('ล้มเหลว', 'error', 0);
  assert.equal(toasts(container).length, 1);
});

test('toast ค้างได้ไม่เกิน 4 ตัว — ตัวที่ 5 ดันตัวเก่าสุดออก', () => {
  const { showToast, container } = loadRender();
  for (let i = 1; i <= 5; i++) showToast(`error ${i}`, 'error', 0);
  const msgs = toasts(container).map((t) => t.dataset.msg);
  assert.deepEqual(msgs, ['error 2', 'error 3', 'error 4', 'error 5']);
});

test('ข้อความเหมือนกันเป๊ะที่ยังค้างอยู่ ไม่สร้างซ้ำ (และไม่นับเป็นตัวใหม่ในลิมิต)', () => {
  const { showToast, container } = loadRender();
  const a = showToast('same', 'error', 0);
  const b = showToast('same', 'error', 0);
  assert.equal(a, b);
  assert.equal(toasts(container).length, 1);
  showToast('same ', 'error', 0); // ต่างกันแค่ช่องว่าง = ไม่ซ้ำเป๊ะ
  assert.equal(toasts(container).length, 2);
});

test('toast ปกติไม่ถูกนับในลิมิตของตัวค้าง และไม่ถูกตัดทิ้ง', () => {
  const { showToast, container } = loadRender();
  showToast('ok', 'success');
  for (let i = 1; i <= 5; i++) showToast(`e${i}`, 'error', 0);
  assert.equal(toasts(container).length, 5); // 1 ปกติ + 4 ค้าง
  assert.ok(toasts(container).some((t) => t.dataset.msg === undefined), 'toast ปกติต้องยังอยู่');
});

test('CSS: ข้อความ toast เลือกคัดลอกได้ (ไม่มี user-select: none บน .toast / .toast-msg)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'components.css'), 'utf8');
  assert.match(css, /\.toast-msg\s*\{[^}]*user-select:\s*text/);
  assert.doesNotMatch(css, /\.toast[^{]*\{[^}]*user-select:\s*none/);
});

test('จุดเรียก error ทุกจุดใน modals.js ส่ง duration 0', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modals.js'), 'utf8');
  const calls = src.match(/showToast\([^;]*'error'[^;]*\);/g) || [];
  assert.ok(calls.length >= 4, `คาดว่ามี showToast error ≥ 4 จุด เจอ ${calls.length}`);
  for (const c of calls) assert.match(c, /'error',\s*0\)/, `ต้องส่ง 0: ${c}`);
});
