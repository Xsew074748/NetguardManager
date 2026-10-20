// ล็อกต่อชื่อบอท (services/bot-lock.js): กันสร้าง/ลบ/ลองใหม่ชื่อเดียวกันซ้อนกัน — คำขอที่สองได้ 409 ทันที ไม่รอคิว
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');

const botLock = require('../services/bot-lock');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('withBotLock: คืนผลของ fn และปล่อยล็อกเมื่อจบ', async () => {
  assert.equal(await botLock.withBotLock('shop', async () => 42), 42);
  assert.equal(botLock.isLocked('shop'), false);
});

test('ชื่อเดียวกันซ้อนกัน → คำขอที่สองถูกปฏิเสธทันทีด้วย 409 (code=busy) โดยไม่รัน fn และไม่ทำให้ล็อกของคำขอแรกหลุด', async () => {
  const gate = deferred();
  let secondRan = false;
  const first = botLock.withBotLock('shop', () => gate.promise);
  assert.equal(botLock.isLocked('shop'), true);
  await assert.rejects(
    botLock.withBotLock('shop', async () => { secondRan = true; }),
    (e) => e.statusCode === 409 && e.code === 'busy' && /shop/.test(e.message),
  );
  assert.equal(secondRan, false);
  assert.equal(botLock.isLocked('shop'), true); // ล็อกยังเป็นของคำขอแรก
  gate.resolve('done');
  assert.equal(await first, 'done');
  assert.equal(botLock.isLocked('shop'), false);
});

test('คนละชื่อไม่บล็อกกัน', async () => {
  const gate = deferred();
  const a = botLock.withBotLock('alpha', () => gate.promise);
  assert.equal(await botLock.withBotLock('beta', async () => 'ok'), 'ok');
  assert.equal(botLock.isLocked('alpha'), true);
  gate.resolve();
  await a;
});

test('fn โยน error (async) → ล็อกถูกปล่อย และ error ถูกส่งต่อ', async () => {
  await assert.rejects(botLock.withBotLock('shop', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(botLock.isLocked('shop'), false);
  assert.equal(await botLock.withBotLock('shop', async () => 'again'), 'again');
});

test('fn โยน error แบบ sync → ล็อกถูกปล่อย', async () => {
  await assert.rejects(botLock.withBotLock('shop', () => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(botLock.isLocked('shop'), false);
});

test('acquire/release: release ซ้ำไม่ปล่อยล็อกของผู้ถือคนใหม่', async () => {
  const release1 = botLock.acquire('shop');
  release1();
  const release2 = botLock.acquire('shop');
  release1(); // เรียกซ้ำจากเจ้าของเก่า
  assert.equal(botLock.isLocked('shop'), true);
  release2();
  assert.equal(botLock.isLocked('shop'), false);
});

test('acquire ตอนมีคนถืออยู่ → 409 และ isLocked ไม่เปลี่ยน', () => {
  const release = botLock.acquire('shop');
  assert.throws(() => botLock.acquire('shop'), (e) => e.statusCode === 409 && e.code === 'busy');
  assert.equal(botLock.isLocked('shop'), true);
  release();
});

test('ชื่อผิดรูปแบบ (ไม่ใช่ชื่อบอท) → 400 ไม่สร้างล็อก', async () => {
  for (const bad of ['', '../x', 'A', 'x', undefined, null, 42, 'a'.repeat(40)]) {
    await assert.rejects(botLock.withBotLock(bad, async () => 1), (e) => e.statusCode === 400, String(bad));
    assert.throws(() => botLock.acquire(bad), (e) => e.statusCode === 400);
    assert.equal(botLock.isLocked(bad), false);
  }
});

test('fn ต้องเป็นฟังก์ชัน', async () => {
  await assert.rejects(botLock.withBotLock('shop', undefined), (e) => e instanceof TypeError && /must be a function/.test(e.message));
  assert.equal(botLock.isLocked('shop'), false);
});

test('สองคำขอพร้อมกันจริง (Promise.allSettled): สำเร็จหนึ่ง ถูกปฏิเสธหนึ่ง', async () => {
  const gate = deferred();
  const results = await Promise.allSettled([
    botLock.withBotLock('shop', async () => { await gate.promise; return 'winner'; }),
    (async () => { await Promise.resolve(); gate.resolve(); return botLock.withBotLock('shop', async () => 'loser'); })(),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.statusCode, 409);
});
