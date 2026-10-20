// ค่าตั้งของฟีเจอร์ "สร้าง Cloudflare Tunnel อัตโนมัติ" — ปิดเป็นค่าเริ่มต้น เปิดได้ก็ต่อเมื่อมีครบทั้ง
//   CF_API_TOKEN_FILE (ไฟล์ที่มี API token, mount เป็น secret — ไม่ใช้ env เพื่อไม่ให้โผล่ใน docker inspect), CF_ACCOUNT_ID, CF_ZONE_ID, CF_ZONE_NAME
// ขาด/ผิดอย่างใดอย่างหนึ่ง = flag ปิด และ log เหตุผลเป็น "ชื่อตัวแปร" เท่านั้น (ห้ามแสดงค่า/พาธของไฟล์ลับ)
// ตัวเลือกเสริม: CF_RESERVED_HOSTS (label หรือ hostname เต็ม คั่นด้วย ,) เพิ่มชื่อสงวนได้เท่านั้น — ชื่อสงวนเริ่มต้น (bot, www, ...) ปลดด้วย config ไม่ได้
//               CF_AUTO_TUNNEL=false (ปิดชัดเจน), CF_TIMEOUT_MS
const fs = require('fs');
const { isValidId, isValidHostname } = require('./cloudflare');

const DEFAULT_TOKEN_FILE = '/run/secrets/cf_token';
const MAX_TOKEN_FILE_BYTES = 4096;
const TOKEN_RE = /^[\x21-\x7e]{8,}$/;

function readTokenFile(file) {
  let stat;
  let raw;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES) throw new Error('unusable');
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error('Cloudflare API token file is not readable');
  }
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) throw new Error('Cloudflare API token file is empty or malformed');
  return token;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// คืน settings ที่ไม่มีค่า token — readToken() อ่านไฟล์สดทุกครั้งที่เรียก (รองรับ rotate)
function loadSettings(env = process.env) {
  const accountId = (env.CF_ACCOUNT_ID || '').trim();
  const zoneId = (env.CF_ZONE_ID || '').trim();
  const zoneName = (env.CF_ZONE_NAME || '').trim();
  const tokenFile = (env.CF_API_TOKEN_FILE || '').trim() || (env.CF_ACCOUNT_ID || env.CF_ZONE_ID || env.CF_ZONE_NAME ? DEFAULT_TOKEN_FILE : '');
  const switchValue = (env.CF_AUTO_TUNNEL || '').trim().toLowerCase();

  const configured = Boolean(accountId || zoneId || zoneName || (env.CF_API_TOKEN_FILE || '').trim() || switchValue);
  const reasons = [];

  if (switchValue === 'false') reasons.push('CF_AUTO_TUNNEL=false (switched off explicitly)');
  if (configured) {
    if (!accountId) reasons.push('CF_ACCOUNT_ID is not set');
    else if (!isValidId(accountId)) reasons.push('CF_ACCOUNT_ID is not a valid id');
    if (!zoneId) reasons.push('CF_ZONE_ID is not set');
    else if (!isValidId(zoneId)) reasons.push('CF_ZONE_ID is not a valid id');
    if (!zoneName) reasons.push('CF_ZONE_NAME is not set');
    else if (!isValidHostname(zoneName)) reasons.push('CF_ZONE_NAME is not a valid lowercase domain name');
    if (!tokenFile) {
      reasons.push('CF_API_TOKEN_FILE is not set');
    } else {
      try {
        readTokenFile(tokenFile);
      } catch (err) {
        reasons.push(`CF_API_TOKEN_FILE is not usable (${err.message.replace('Cloudflare API token file ', '')})`);
      }
    }
  }

  const timeoutMs = Number(env.CF_TIMEOUT_MS);
  return {
    configured,
    enabled: configured && reasons.length === 0,
    reasons,
    accountId,
    zoneId,
    zoneName,
    reserved: parseList(env.CF_RESERVED_HOSTS),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
    readToken: () => readTokenFile(tokenFile),
  };
}

function logSettings(settings, logger) {
  if (!settings.configured) {
    logger.info('Cloudflare auto-tunnel: off (not configured)');
  } else if (!settings.enabled) {
    logger.warn(`Cloudflare auto-tunnel: off — ${settings.reasons.join('; ')}`);
  } else {
    logger.info('Cloudflare auto-tunnel: on');
  }
}

module.exports = { loadSettings, logSettings, DEFAULT_TOKEN_FILE };
