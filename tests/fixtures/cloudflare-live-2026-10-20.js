// Fixture จากผลทดสอบ Cloudflare "จริง" เมื่อ 2026-10-20 (backups/predeploy/cf-live-test/cf-live-test-summary-20261020-080100.md)
// ใส่เฉพาะสิ่งที่สรุปผลบันทึกไว้จริง: รหัส error, สถานะ HTTP, ชื่อฟิลด์ที่เห็น, ความยาว/ชุดอักขระของ token, ชื่อ header
// ที่ "ไม่ได้บันทึก" (เป็นค่าสมมติ): ข้อความ message ของ error, timestamp, ID, ค่า token (ค่าสังเคราะห์ให้ยาว 240 และมี + / = เหมือน base64)
const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '3a3f2c1e-9b47-4d6a-8c15-0e7d2b9a1f64';
const REC = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const HOST = 'cf-livetest.example.com';
const NAME = 'netguard-livetest';
const DELETED_AT = '2026-10-20T08:01:05.123456Z';

// token ของ tunnel ที่จริงยาว 240 ตัว ขึ้นต้น "ey" ชุดอักขระ base64 — สร้างค่าสังเคราะห์ที่มีรูปแบบเดียวกัน (179 ไบต์ → 240 ตัวอักษรรวม padding =)
function syntheticTunnelToken() {
  const head = Buffer.from('{"a":"');
  const body = Buffer.from(Array.from({ length: 179 - head.length }, (_, i) => (i * 61 + 250) & 255));
  return Buffer.concat([head, body]).toString('base64');
}
const TUNNEL_TOKEN_240 = syntheticTunnelToken();

const envelope = (result, extra = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const failure = (code, message) => ({ success: false, errors: [{ code, message }], messages: [], result: null });

// result_info ของรายการ (ชื่อฟิลด์ตามที่เห็นจริง: count,page,per_page,total_count,total_pages)
const listInfo = (count) => ({ count, page: 1, per_page: 100, total_count: count, total_pages: count === 0 ? 0 : 1 });

const cname = (over = {}) => ({
  id: REC, type: 'CNAME', name: HOST, content: `${TID}.cfargotunnel.com`, proxied: true, ttl: 1, comment: 'managed-by=netguard-live-test', ...over,
});

const liveTunnel = (over = {}) => ({ id: TID, name: NAME, status: 'inactive', deleted_at: null, connections: [], ...over });
const deletedTunnel = (over = {}) => liveTunnel({ deleted_at: DELETED_AT, ...over });

module.exports = {
  ACCT, ZONE, TID, REC, HOST, NAME, DELETED_AT, TUNNEL_TOKEN_240,
  dnsListOne: () => envelope([cname()], { result_info: listInfo(1) }),
  dnsListEmpty: () => envelope([], { result_info: listInfo(0) }),
  // DELETE DNS ซ้ำ: HTTP 404 รหัส 81044 (ข้อความเป็นค่าสมมติ)
  dnsDelete404: () => failure(81044, 'Record does not exist.'),
  dnsDeleteOk: () => envelope({ id: REC }),
  // list tunnel ตาม uuid หลังลบ: is_deleted=false → 0 รายการ, is_deleted=true → 1 รายการ
  tunnelListLive: (rows) => envelope(rows, { result_info: listInfo(rows.length) }),
  tunnelGetLive: () => envelope(liveTunnel()),
  // GET tunnel ที่ลบแล้ว: HTTP 200 พร้อม deleted_at (ไม่ใช่ 404)
  tunnelGetDeleted: () => envelope(deletedTunnel()),
  // DELETE tunnel (รวมครั้งที่สองที่ tunnel ถูกลบไปแล้ว): HTTP 200 success
  tunnelDeleteOk: () => envelope(deletedTunnel()),
  tunnelCreate: () => envelope({ ...liveTunnel(), token: TUNNEL_TOKEN_240 }),
  tokenResult: () => envelope(TUNNEL_TOKEN_240),
  // header ของ rate limit ที่เห็นจริงในคำตอบ 200 (รูปแบบ structured field; ไม่มี x-ratelimit-* และไม่เคยเห็นคำตอบ 429 จึงไม่รู้ว่ามี Retry-After หรือไม่)
  rateHeaders: { ratelimit: '"default";r=1199;t=1', 'ratelimit-policy': '"default";q=1200;w=300' },
};
