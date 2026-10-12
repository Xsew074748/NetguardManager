// กัน CSRF แบบ 2 ชั้น สำหรับ route ที่เปลี่ยนสถานะสำคัญ (ใช้ซ้ำได้ — ตอนนี้ครอบเฉพาะ POST /api/auth/password ยังไม่ครอบทุก route)
//   ชั้น 1: ต้องมี header X-Requested-With (ค่าอะไรก็ได้ที่ไม่ว่าง) — ฟอร์ม/ลิงก์ข้ามเว็บใส่ header นี้ไม่ได้ ถ้าไม่ผ่าน CORS preflight (Manager ไม่เปิด CORS)
//   ชั้น 2: ถ้ามี Origin ต้องชี้ host เดียวกับ Host ของคำขอ (หรือ X-Forwarded-Host ตัวแรก เมื่อผ่าน proxy/tunnel)
//           ไม่เทียบ Origin อย่างเดียว: Manager อาจอยู่หลัง Cloudflare tunnel — browser ส่ง Origin เป็นโดเมนภายนอก แต่ Host ที่ container เห็นอาจเป็นชื่อภายใน
//           จึงเทียบกับทั้ง Host และ X-Forwarded-Host (ตัวแรก) ไม่มีทั้งสองแต่มี Origin = ปฏิเสธ
// ไม่มี Origin (เช่น curl, same-origin GET/POST บางกรณี) ผ่านชั้น 2 ได้ เพราะชั้น 1 ยังคุมอยู่
const HEADER = 'x-requested-with';

function firstValue(v) {
  if (v === undefined || v === null) return '';
  return String(Array.isArray(v) ? v[0] : v).split(',')[0].trim().toLowerCase();
}

function originHost(origin) {
  try {
    const u = new URL(String(origin));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

// onReject(req, reason) เรียกตอนปฏิเสธ (reason = 'missing-header' | 'origin-mismatch') — ใช้เขียน audit; ห้าม throw ออกมา
function requireSameOrigin({ onReject = () => {} } = {}) {
  const reject = (req, res, reason) => {
    try { onReject(req, reason); } catch { /* ห้ามทำให้ตอบ 403 ไม่ได้ */ }
    return res.status(403).json({ error: 'Forbidden (cross-site request blocked)' });
  };
  return function csrfGuard(req, res, next) {
    const headers = req.headers || {};
    if (!firstValue(headers[HEADER])) return reject(req, res, 'missing-header');

    const origin = headers.origin;
    if (origin !== undefined && origin !== '') {
      const oh = originHost(origin);
      const hosts = [firstValue(headers.host), firstValue(headers['x-forwarded-host'])].filter(Boolean);
      if (!oh || !hosts.includes(oh)) return reject(req, res, 'origin-mismatch');
    }
    next();
  };
}

module.exports = { requireSameOrigin };
