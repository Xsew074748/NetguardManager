// Audit log การกระทำผ่าน Manager (ใคร/ทำอะไร/กับอะไร/ผลเป็นอย่างไร) — เก็บใน stats.db ตาราง audit_log
//
// หลักการ: ห้ามมี secret ลงตาราง — ทุก detail/ข้อความผ่าน sanitize ที่นี่เสมอ (ไม่รับ req.body ทั้งก้อน):
//   • key ที่ชื่อบ่งชี้ความลับ (password/secret/token/key/hash/...) ถูกตัดทิ้ง
//   • ค่าที่หน้าตาเป็น token (ยาว ≥ 24 ตัวอักษรไร้ช่องว่าง) ถูกแทนด้วย [redacted]
//   • รับเฉพาะค่าพื้นฐาน (string/number/boolean) และ array ของค่าพื้นฐาน; object ซ้อนถูกตัดทิ้ง
// การเขียน audit ล้มเหลวต้องไม่ทำให้ action ล้ม (log error แล้วไปต่อ)
const statsDb = require('./stats-db');
const guard = require('../middleware/guard');
const logger = require('./logger');

const SENSITIVE_KEY_RE = /pass(word|wd)?|secret|token|api[-_]?key|apikey|app[-_]?key|authorization|cookie|credential|bearer|private|hash|signature|\bsk\b|\bak\b/i;
const TOKENISH_RE = /[A-Za-z0-9_\-+/=.]{24,}/g;
const MAX_STR = 200;
const MAX_KEYS = 20;
const MAX_ARRAY = 20;
const MAX_DETAIL_JSON = 1000;

function sanitizeText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(TOKENISH_RE, '[redacted]');
  return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : s;
}

function sanitizeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return sanitizeText(v);
  return undefined; // object/function/symbol ฯลฯ → ตัดทิ้ง
}

// คืน JSON string (หรือ null ถ้าไม่เหลืออะไร)
function sanitizeDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(detail)) {
    if (n >= MAX_KEYS) break;
    if (SENSITIVE_KEY_RE.test(k)) continue;
    let val;
    if (Array.isArray(v)) {
      val = v.slice(0, MAX_ARRAY).map(sanitizeValue).filter((x) => x !== undefined);
    } else {
      val = sanitizeValue(v);
      if (val === undefined) continue;
    }
    out[String(k).slice(0, 40)] = val;
    n++;
  }
  if (n === 0) return null;
  const json = JSON.stringify(out);
  return json.length > MAX_DETAIL_JSON ? JSON.stringify({ truncated: true }) : json;
}

function shortTarget(t) {
  if (t === null || t === undefined || t === '') return null;
  const s = String(t);
  return /^[0-9a-f]{40,}$/i.test(s) ? s.slice(0, 12) : sanitizeText(s); // container id เต็ม → ย่อ 12 ตัวแบบ docker
}

// เขียน 1 รายการ — ไม่ throw
function record({ req = null, actor, ip, action, target = null, result, detail = null }) {
  try {
    const token = req && req.cookies ? req.cookies[guard.SESSION_COOKIE] : null;
    statsDb.insertAudit({
      actor: actor || guard.sessionActor(token),
      ip: ip || (req && req.ip) || null,
      action: String(action).slice(0, 60),
      target: shortTarget(target),
      result,
      detail: sanitizeDetail(detail),
    });
  } catch (err) {
    logger.error(`audit: เขียนไม่สำเร็จ (${action}): ${err.message}`);
  }
}

// ชื่อ action ของ route ที่เปลี่ยนสถานะ — route ที่ไม่อยู่ในตารางใช้ "METHOD /path" แทน (ไม่หลุดเงียบ)
const ROUTE_ACTIONS = {
  'POST /bots': 'bot.create',
  'POST /bots/:id/start': 'bot.start',
  'POST /bots/:id/stop': 'bot.stop',
  'POST /bots/:id/restart': 'bot.restart',
  'DELETE /bots/:id': 'bot.remove',
  'POST /image/pull': 'image.pull',
  'POST /bots/:name/tunnel': 'tunnel.attach',
  'DELETE /bots/:name/tunnel': 'tunnel.detach',
  'PUT /bots/:name/meta': 'bot.meta.update',
  'PUT /bots/:name/config': 'bot.config.update',
  'PUT /bots/:name/daily-summary': 'bot.daily-summary.update',
  'POST /bots/:id/test-connection': 'bot.test-connection',
};

// middleware สำหรับ router ที่ผ่าน requireAuth แล้ว: ทุก request ที่ไม่ใช่ GET/HEAD/OPTIONS ถูกบันทึกตอนตอบกลับเสร็จ
// handler เติมรายละเอียดได้ที่ res.locals.audit = { target, detail } (เฉพาะชื่อ field/ค่าที่ไม่ลับ)
function auditMutations(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.locals.audit = {};
  // params ของ route ที่จับคู่ได้ ณ ตอนนี้ยังไม่มี (ยังไม่เข้า route) — เก็บตอน finish
  res.on('finish', () => {
    const routePath = req.route ? req.route.path : req.path;
    const key = `${req.method} ${routePath}`;
    const a = res.locals.audit || {};
    const target = a.target !== undefined ? a.target : (req.params && (req.params.name || req.params.id)) || null;
    const ok = res.statusCode < 400;
    record({
      req,
      action: ROUTE_ACTIONS[key] || key,
      target,
      result: ok ? 'ok' : 'fail',
      detail: { ...(a.detail || {}), status: res.statusCode, ...(ok || !res.locals.auditError ? {} : { error: res.locals.auditError }) },
    });
  });
  next();
}

module.exports = { record, sanitizeDetail, sanitizeText, auditMutations, ROUTE_ACTIONS };
