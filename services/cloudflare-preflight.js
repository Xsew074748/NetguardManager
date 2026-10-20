// กฎ hostname + preflight (อ่านอย่างเดียว) ก่อนสร้าง Cloudflare Tunnel อัตโนมัติ (แผน: cf-auto-tunnel-plan.md) — ยังไม่ถูกเรียกจากที่ไหนในแอป
//
// preflight ไม่เขียนอะไรเลย: ตรวจกฎ hostname → ตรวจ state/รายการค้างในเครื่อง → ตรวจ Cloudflare ว่าไม่มี DNS ชื่อนี้และไม่มี tunnel ชื่อ netguard-<บอท>
// ตรวจฝั่งใดไม่ได้ (state เสีย / Cloudflare ล้ม) = หยุด ไม่ถือว่า "ว่าง" และไม่เขียนทับ record เดิมเด็ดขาด (ชนเมื่อไรคือ 409)
const { CloudflareError, isValidHostname } = require('./cloudflare');

const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// ชื่อสงวนเริ่มต้น (label ใต้ zone) — เพิ่มได้ผ่านพารามิเตอร์ reserved (label หรือ hostname เต็ม) เช่น hostname production จริง
const DEFAULT_RESERVED = ['www', 'bot', 'mail', 'ftp', 'admin', 'api', 'manager', 'ns1', 'ns2'];

class PreflightError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'PreflightError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function badConfig(message) {
  return new PreflightError(`Cloudflare auto-tunnel is misconfigured: ${message}`, 500, 'bad-config');
}

function invalidHostname(message) {
  return new PreflightError(message, 400, 'invalid-hostname');
}

// ตัดเฉพาะช่องว่างหัวท้าย (ไม่ใช้ trim() เพราะมันตัด \n ทิ้งด้วย ซึ่งต้องถูกปฏิเสธ) แล้วทำเป็นตัวพิมพ์เล็ก
function normalize(v) {
  return v.replace(/^ +| +$/g, '').toLowerCase();
}

// คืน hostname ที่ normalize แล้ว หรือโยน PreflightError (400 invalid-hostname / reserved-hostname, 500 bad-config)
function validateAutoHostname(hostname, { zoneName, reserved = [] } = {}) {
  if (!isValidHostname(zoneName)) throw badConfig('zone name is missing or invalid');
  if (!Array.isArray(reserved) || reserved.some((r) => typeof r !== 'string')) throw badConfig('reserved list must be an array of strings');
  if (typeof hostname !== 'string') throw invalidHostname('Hostname must be a string');

  const host = normalize(hostname);
  if (!isValidHostname(host)) throw invalidHostname('Hostname is not a valid DNS name (lowercase letters, digits, hyphens; no wildcard)');
  const suffix = `.${zoneName}`;
  if (!host.endsWith(suffix)) throw invalidHostname(`Hostname must be <name>${suffix}`);
  const label = host.slice(0, -suffix.length);
  if (label.includes('.')) throw invalidHostname(`Hostname must have exactly one label before ${suffix}`);
  if (label.startsWith('xn--')) throw invalidHostname('Internationalized (xn--) names are not accepted');

  const blocked = new Set([...DEFAULT_RESERVED, ...reserved].map((r) => r.toLowerCase()));
  if (blocked.has(label) || blocked.has(host)) {
    throw new PreflightError(`Hostname "${host}" is reserved`, 400, 'reserved-hostname');
  }
  return host;
}

// plan = { hostname, tunnelName, service } ที่ขั้นสร้างจริงต้องใช้
async function preflightAutoTunnel({ client, state, botName, hostname, zoneName, reserved } = {}) {
  if (!client || typeof client.findDnsRecords !== 'function' || typeof client.findTunnelsByName !== 'function') {
    throw badConfig('Cloudflare client is not available');
  }
  const store = state || require('./cloudflare-state');
  if (typeof botName !== 'string' || !BOT_NAME_RE.test(botName)) {
    throw new PreflightError('Invalid bot name', 400, 'invalid-bot-name');
  }
  const host = validateAutoHostname(hostname, { zoneName, reserved });
  const tunnelName = `netguard-${botName}`;

  // 1) ในเครื่อง — state ที่อ่านไม่ได้ต้องหยุด (มองไม่เห็นว่า hostname ถูกใช้อยู่หรือไม่)
  let existing;
  let states;
  let orphans;
  try {
    existing = store.readState(botName);
    states = store.listStates();
    orphans = store.listOrphans();
  } catch (err) {
    throw new PreflightError(`Cannot read Cloudflare state files: ${err && err.message ? err.message : 'unknown error'}`, 500, 'state-unreadable');
  }
  if (existing) throw new PreflightError(`Bot "${botName}" already has Cloudflare state — retry or clean up instead of creating again`, 409, 'state-exists');
  if (states.some((s) => s.botName !== botName && s.state && s.state.hostname === host)) {
    throw new PreflightError(`Hostname "${host}" is already used by another bot`, 409, 'hostname-in-use');
  }
  if (orphans.some((o) => o.hostname === host || o.botName === botName)) {
    throw new PreflightError('Leftover Cloudflare resources from an earlier deletion must be cleaned up first', 409, 'orphan-exists');
  }

  // 2) Cloudflare (อ่านอย่างเดียว) — ตรวจไม่ได้ = ล้ม ไม่ใช่ "ว่าง"
  let records;
  let tunnels;
  try {
    records = await client.findDnsRecords(host);
    if (records.length === 0) tunnels = await client.findTunnelsByName(tunnelName);
  } catch (err) {
    if (err instanceof CloudflareError) {
      throw new PreflightError(`Could not verify Cloudflare state (${err.message})`, 502, 'cloudflare-check-failed');
    }
    throw err;
  }
  if (records.length > 0) {
    const types = [...new Set(records.map((r) => r.type))].join(', ');
    throw new PreflightError(`A DNS record already exists for "${host}" (${types}) — not overwriting`, 409, 'hostname-in-use');
  }
  if (tunnels.length > 0) throw new PreflightError(`A tunnel named "${tunnelName}" already exists`, 409, 'tunnel-exists');

  return { hostname: host, tunnelName, service: `http://${tunnelName}:3000` };
}

module.exports = { PreflightError, DEFAULT_RESERVED, validateAutoHostname, preflightAutoTunnel };
