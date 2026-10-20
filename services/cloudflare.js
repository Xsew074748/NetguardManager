// Cloudflare API client สำหรับสร้าง/ลบ Tunnel + DNS อัตโนมัติ (แผน: cf-auto-tunnel-plan.md) — ยังไม่ถูกเรียกจากที่ไหนในแอป
//
// หลักการ:
//   • ฉีด fetch / sleep / random ได้ (เทสต์ไม่ยิงจริง) และอ่าน API token จาก getToken() ทุกคำขอ — client ไม่ถือ token ไว้เอง
//   • timeout ต่อคำขอด้วย AbortSignal; retry แบบถอยเวลาเฉพาะ GET/DELETE (POST/PUT ที่สร้างของห้ามซ้ำ — ผู้เรียกต้องตรวจสถานะเอง)
//   • error ไม่ใส่ body/header/ข้อความดิบของ fetch: ประกอบจาก op + status + รหัส/ข้อความของ Cloudflare เท่านั้น แล้ว redact token
//   • ตรวจ ID/hostname ก่อนยิงเสมอ (กัน path injection และค่าแปลกต่อท้าย cfargotunnel.com)
// ข้อสมมติที่ "ยังไม่ยืนยัน" ในแผน ไม่ถูกพึ่งพา: การกรองฝั่ง Cloudflare (กรองซ้ำเอง + ปฏิเสธถ้าผลไม่ครบ), รหัส error ของลบซ้ำ/ชนชื่อ (ใช้ HTTP status),
// การลบ tunnel ที่ยังมี connection (ลบ → ล้มด้วยเหตุใดก็ตาม → cleanup connections → ลองอีกครั้งเดียว)
const BASE_URL = 'https://api.cloudflare.com/client/v4';

const ID_RE = /^[A-Za-z0-9]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const SERVICE_RE = /^https?:\/\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::\d{1,5})?$/;
const OWNED_TUNNEL_NAME_RE = /^netguard-[a-z0-9][a-z0-9-]{1,30}$/; // netguard-<ชื่อบอท> ตาม BOT_NAME_RE ของ Manager
const TUNNEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TOKEN_RE = /^[\x21-\x7e]{8,}$/; // อักขระที่พิมพ์ได้ ไม่มีช่องว่าง/ขึ้นบรรทัดใหม่ (กัน header injection)
const TOKENISH_RE = /[A-Za-z0-9_\-+/=.]{24,}/g;
const MAX_CF_MESSAGE = 200;
const MAX_CF_ERRORS = 3;

function isValidId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}
function isValidTunnelId(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}
function isValidHostname(v) {
  return typeof v === 'string' && v.length <= 253 && HOSTNAME_RE.test(v);
}

class CloudflareError extends Error {
  constructor(message, { op, code, status = null, cfCodes = [], retryable = false, attempts = 1 } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.op = op;
    this.code = code;
    this.status = status;
    this.cfCodes = cfCodes;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

function positive(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return v;
}

function createCloudflareClient(options = {}) {
  const {
    accountId, zoneId, getToken,
    fetch: injectedFetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    baseUrl = BASE_URL,
  } = options;
  if (!isValidId(accountId)) throw new TypeError('accountId must be 1-32 letters/digits');
  if (!isValidId(zoneId)) throw new TypeError('zoneId must be 1-32 letters/digits');
  if (typeof getToken !== 'function') throw new TypeError('getToken must be a function');
  const timeoutMs = positive('timeoutMs', options.timeoutMs === undefined ? 10000 : options.timeoutMs);
  const baseDelayMs = positive('baseDelayMs', options.baseDelayMs === undefined ? 500 : options.baseDelayMs);
  const maxDelayMs = positive('maxDelayMs', options.maxDelayMs === undefined ? 10000 : options.maxDelayMs);
  const maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError('maxRetries must be an integer >= 0');

  // token ปัจจุบันถูกส่งเข้า redact เฉพาะตอนสร้างข้อความ error — ไม่เก็บไว้ที่ client
  function redact(text, token) {
    let s = String(text);
    if (token) s = s.split(token).join('[redacted]');
    return s.replace(TOKENISH_RE, '[redacted]');
  }

  function fail(op, code, message, extra = {}) {
    return new CloudflareError(`cloudflare ${op}: ${message}`, { op, code, ...extra });
  }

  async function resolveToken(op) {
    let token;
    try {
      token = await getToken();
    } catch {
      throw fail(op, 'no-token', 'API token is not available');
    }
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw fail(op, 'no-token', 'API token is not available');
    return token;
  }

  function backoff(attempt) {
    return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + 0.5 * random());
  }

  function retryDelay(attempt, status, headers) {
    if (status === 429 || status === 503) {
      const ra = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
      if (ra && /^\d+$/.test(ra.trim())) return Math.min(maxDelayMs, Number(ra) * 1000);
    }
    return backoff(attempt);
  }

  function httpError(op, token, status, parsed, attempts) {
    const errs = parsed && Array.isArray(parsed.errors) ? parsed.errors.slice(0, MAX_CF_ERRORS) : [];
    const cfCodes = errs.map((e) => e && e.code).filter((c) => Number.isInteger(c));
    const details = errs
      .map((e) => {
        const msg = e && typeof e.message === 'string' ? redact(e.message.slice(0, MAX_CF_MESSAGE), token) : '';
        return e && Number.isInteger(e.code) ? `code ${e.code}${msg ? `: ${msg}` : ''}` : msg;
      })
      .filter(Boolean);
    const text = `HTTP ${status}${details.length ? ` [${details.join('; ')}]` : ''}`;
    return fail(op, 'http', text, { status, cfCodes, retryable: status === 429 || status >= 500, attempts });
  }

  // คืน envelope ที่ parse แล้ว (success:true) หรือโยน CloudflareError
  async function request(op, method, apiPath, { query, body } = {}) {
    const idempotent = method === 'GET' || method === 'DELETE';
    let url = `${baseUrl}${apiPath}`;
    if (query) url += `?${new URLSearchParams(query).toString()}`;

    for (let attempt = 0; ; attempt++) {
      const token = await resolveToken(op);
      let err;
      let status = null;
      let headers = null;
      // ตัวจับเวลาของเราเอง (ไม่ใช้ AbortSignal.timeout: ตัวนั้น unref จึงไม่ปลุก event loop — ในสคริปต์/เทสต์ที่ไม่มีอย่างอื่นค้างอยู่ คำขอที่ค้างจะไม่ถูกตัด)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
      try {
        const res = await (injectedFetch || globalThis.fetch)(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        status = res.status;
        headers = res.headers;
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
        if (res.ok && parsed && parsed.success === true) return parsed;
        if (res.ok && !parsed) {
          err = fail(op, 'invalid-response', `HTTP ${status} with a non-JSON body`, { status, attempts: attempt + 1 });
        } else {
          err = httpError(op, token, status, parsed, attempt + 1);
        }
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          err = fail(op, 'timeout', `timed out after ${timeoutMs}ms`, { retryable: true, attempts: attempt + 1 });
        } else {
          // ไม่ใช้ e.message / e.cause: ข้อความของ fetch อาจสะท้อน header (token) — เก็บแค่รหัสระบบที่เป็นตัวพิมพ์ใหญ่
          const sys = e && typeof e.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(e.code) ? ` (${e.code})` : '';
          err = fail(op, 'network', `network error${sys}`, { retryable: true, attempts: attempt + 1 });
        }
      } finally {
        clearTimeout(timer);
      }
      if (!(idempotent && err.retryable && attempt < maxRetries)) throw err;
      await sleep(retryDelay(attempt, status, headers));
    }
  }

  function need(ok, op, code, what) {
    if (!ok) throw fail(op, code, `invalid ${what}`);
  }

  // ผลลัพธ์แบบ list: ตรวจว่าเป็น array และถ้า Cloudflare บอกว่ามีมากกว่าที่ส่งมา (กรองไม่ทำงาน/ไม่ครบ) ต้องไม่สรุปว่า "ไม่พบ"
  function listResult(op, envelope) {
    if (!Array.isArray(envelope.result)) throw fail(op, 'invalid-response', 'result is not a list');
    const info = envelope.result_info;
    if (info && Number.isFinite(info.total_count) && info.total_count > envelope.result.length) {
      throw fail(op, 'invalid-response', 'result list is incomplete (more rows than returned)');
    }
    return envelope.result;
  }

  const acct = `/accounts/${accountId}/cfd_tunnel`;
  const zone = `/zones/${zoneId}/dns_records`;

  async function findDnsRecords(hostname) {
    const op = 'findDnsRecords';
    need(isValidHostname(hostname), op, 'invalid-argument', 'hostname');
    const env = await request(op, 'GET', zone, { query: { 'name.exact': hostname, per_page: '100' } });
    return listResult(op, env)
      .filter((r) => r && typeof r.name === 'string' && r.name.toLowerCase() === hostname)
      .map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied }));
  }

  async function findTunnelsByName(name) {
    const op = 'findTunnelsByName';
    need(typeof name === 'string' && TUNNEL_NAME_RE.test(name), op, 'invalid-argument', 'tunnel name');
    const env = await request(op, 'GET', acct, { query: { name, is_deleted: 'false', per_page: '100' } });
    return listResult(op, env)
      .filter((t) => t && t.name === name && !t.deleted_at)
      .map((t) => ({ id: t.id, name: t.name }));
  }

  async function createTunnel(name) {
    const op = 'createTunnel';
    need(typeof name === 'string' && TUNNEL_NAME_RE.test(name), op, 'invalid-argument', 'tunnel name');
    const env = await request(op, 'POST', acct, { body: { name, config_src: 'cloudflare' } });
    const r = env.result;
    if (!r || !isValidTunnelId(r.id)) throw fail(op, 'invalid-response', 'response has no tunnel id');
    const out = { id: r.id };
    // token ไม่ enumerable: JSON.stringify / spread / console.log ของผลลัพธ์จะไม่เห็น
    Object.defineProperty(out, 'token', { value: typeof r.token === 'string' && r.token ? r.token : null, enumerable: false });
    return out;
  }

  async function getTunnelToken(tunnelId) {
    const op = 'getTunnelToken';
    need(isValidTunnelId(tunnelId), op, 'invalid-id', 'tunnel id');
    const env = await request(op, 'GET', `${acct}/${tunnelId}/token`);
    if (typeof env.result !== 'string' || !env.result) throw fail(op, 'invalid-response', 'result is not a token string');
    return env.result;
  }

  async function putIngress(tunnelId, { hostname, service } = {}) {
    const op = 'putIngress';
    need(isValidTunnelId(tunnelId), op, 'invalid-id', 'tunnel id');
    need(isValidHostname(hostname), op, 'invalid-argument', 'hostname');
    need(typeof service === 'string' && SERVICE_RE.test(service), op, 'invalid-argument', 'service');
    // Cloudflare บังคับให้ rule สุดท้ายเป็น catch-all (ไม่มี hostname)
    await request(op, 'PUT', `${acct}/${tunnelId}/configurations`, {
      body: { config: { ingress: [{ hostname, service }, { service: 'http_status:404' }] } },
    });
  }

  async function createCname({ hostname, tunnelId, comment } = {}) {
    const op = 'createCname';
    need(isValidTunnelId(tunnelId), op, 'invalid-id', 'tunnel id');
    need(isValidHostname(hostname), op, 'invalid-argument', 'hostname');
    need(comment === undefined || (typeof comment === 'string' && comment.length <= 100 && !/[\r\n]/.test(comment)), op, 'invalid-argument', 'comment');
    const body = { type: 'CNAME', name: hostname, content: `${tunnelId.toLowerCase()}.cfargotunnel.com`, proxied: true };
    if (comment !== undefined) body.comment = comment;
    const env = await request(op, 'POST', zone, { body });
    if (!env.result || !isValidId(env.result.id)) throw fail(op, 'invalid-response', 'response has no record id');
    return { id: env.result.id };
  }

  // ลบ DNS record เฉพาะที่เป็นของเรา: ต้องเห็น record id นี้ในผล list ตามชื่อ เป็น CNAME ที่ชี้ <tunnelId>.cfargotunnel.com เท่านั้น
  // ไม่พบใน list = ลบไปแล้ว (list สำเร็จจึงเชื่อได้; ถ้า list ล้มจะ throw ไม่ถือว่าลบแล้ว) · DELETE ได้ 404 → list ซ้ำก่อนสรุป (404 อาจมาจาก zone/account ID ผิด)
  async function deleteDnsRecord(recordId, { hostname, tunnelId } = {}) {
    const op = 'deleteDnsRecord';
    need(isValidId(recordId), op, 'invalid-id', 'record id');
    need(isValidTunnelId(tunnelId), op, 'invalid-id', 'tunnel id');

    const record = (await findDnsRecords(hostname)).find((r) => r.id === recordId);
    if (!record) return { deleted: false, alreadyGone: true };
    const ours = `${tunnelId.toLowerCase()}.cfargotunnel.com`;
    if (record.type !== 'CNAME' || typeof record.content !== 'string' || record.content.toLowerCase() !== ours) {
      throw fail(op, 'not-owned', 'record is not a CNAME to this tunnel — refusing to delete');
    }
    try {
      await request(op, 'DELETE', `${zone}/${recordId}`);
      return { deleted: true, alreadyGone: false };
    } catch (e) {
      if (!(e instanceof CloudflareError) || e.status !== 404) throw e;
    }
    const stillThere = (await findDnsRecords(hostname)).some((r) => r.id === recordId);
    if (stillThere) throw fail(op, 'delete-unconfirmed', 'DELETE returned 404 but the record is still listed (wrong account/zone?)');
    return { deleted: false, alreadyGone: true };
  }

  async function findTunnelById(tunnelId) {
    const op = 'findTunnelById';
    need(isValidTunnelId(tunnelId), op, 'invalid-id', 'tunnel id');
    const env = await request(op, 'GET', acct, { query: { uuid: tunnelId, is_deleted: 'false', per_page: '100' } });
    const found = listResult(op, env).find((t) => t && typeof t.id === 'string' && t.id.toLowerCase() === tunnelId.toLowerCase() && !t.deleted_at);
    return found ? { id: found.id, name: found.name } : null;
  }

  async function cleanupConnections(tunnelId) {
    await request('cleanupConnections', 'DELETE', `${acct}/${tunnelId}/connections`);
  }

  async function confirmTunnelGone(op, tunnelId) {
    if (await findTunnelById(tunnelId)) throw fail(op, 'delete-unconfirmed', 'got 404 but the tunnel is still listed (wrong account?)');
    return { deleted: false, alreadyGone: true };
  }

  // { result } เมื่อจบเรื่อง (ลบแล้ว/ยืนยันแล้วว่าไม่อยู่) หรือ { error } เมื่อควรลอง cleanup connections แล้วลบซ้ำ
  async function tryDeleteTunnel(tunnelId) {
    try {
      await request('deleteTunnel', 'DELETE', `${acct}/${tunnelId}`);
      return { result: { deleted: true, alreadyGone: false } };
    } catch (e) {
      if (!(e instanceof CloudflareError) || e.code === 'no-token') throw e;
      if (e.status === 404) return { result: await confirmTunnelGone('deleteTunnel', tunnelId) };
      return { error: e };
    }
  }

  // ป้องกันลบ tunnel ผิดตัว (เช่น state ถูกแก้ให้ชี้ tunnel production): GET ตาม id ก่อน และต้องชื่อตรงกับ expectedName (netguard-<บอท>) เป๊ะ
  // เอกสารบอกแค่ว่า tunnel ต้องไม่มี connection ตอนลบ (ไม่ระบุรหัส error) → ลบล้มเหลวเหตุใดก็ตาม ให้ cleanup connections แล้วลองอีกครั้งเดียว
  async function deleteTunnel(tunnelId, { expectedName } = {}) {
    const op = 'deleteTunnel';
    need(isValidTunnelId(tunnelId), op, 'invalid-id', 'tunnel id');
    need(typeof expectedName === 'string' && OWNED_TUNNEL_NAME_RE.test(expectedName), op, 'invalid-argument', 'expected tunnel name (must be netguard-<bot>)');

    let tunnel;
    try {
      tunnel = (await request(op, 'GET', `${acct}/${tunnelId}`)).result;
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) return confirmTunnelGone(op, tunnelId);
      throw e;
    }
    if (!tunnel || typeof tunnel.id !== 'string' || typeof tunnel.name !== 'string') throw fail(op, 'invalid-response', 'tunnel response has no id/name');
    if (tunnel.id.toLowerCase() !== tunnelId.toLowerCase()) throw fail(op, 'not-owned', 'tunnel response id does not match the requested id');
    if (tunnel.name !== expectedName) throw fail(op, 'not-owned', `tunnel name does not match "${expectedName}" — refusing to delete`);
    if (tunnel.deleted_at) return { deleted: false, alreadyGone: true };

    const first = await tryDeleteTunnel(tunnelId);
    if (first.result) return first.result;
    await cleanupConnections(tunnelId);
    const second = await tryDeleteTunnel(tunnelId);
    if (second.result) return second.result;
    throw second.error;
  }

  return {
    findDnsRecords,
    findTunnelsByName,
    createTunnel,
    getTunnelToken,
    putIngress,
    createCname,
    findTunnelById,
    deleteDnsRecord,
    deleteTunnel,
  };
}

module.exports = {
  createCloudflareClient,
  CloudflareError,
  isValidId,
  isValidTunnelId,
  isValidHostname,
};
