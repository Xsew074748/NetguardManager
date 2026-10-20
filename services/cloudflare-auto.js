// ตัวประสานงานสร้าง/ล้าง Cloudflare Tunnel อัตโนมัติต่อบอท (แผน: cf-auto-tunnel-plan.md)
//
// ไม่รู้จัก Docker/Express โดยตรง — รับ client Cloudflare, state store และ ops ของ Docker เข้ามาจากข้างนอก (เทสต์ฉีดตัวจำลองได้ทั้งหมด)
// ไม่ล็อกเอง: ผู้เรียกต้องถือ withBotLock(ชื่อบอท) ตลอดช่วง preflight + provision (หรือ teardown)
//
// provision: tunnel → เขียน state ล่วงหน้า → ingress → DNS → ขอ token → เขียน .env → เริ่ม container cloudflared
//   ล้มขั้นใด = rollback เฉพาะสิ่งที่สร้างไปแล้ว ตามลำดับ container → DNS → tunnel → token ใน .env → state
//   ขั้น rollback ที่ล้ม "ไม่หยุดทั้งหมด" — ลงรายการใน cf-orphans.json แล้วไปขั้นถัดไป; ลง orphan ไม่ได้ก็เก็บ state ไว้และ log error
// token ของ tunnel อยู่แค่ในตัวแปรชั่วคราวของ provision (ส่งให้ ops เท่านั้น) — ไม่ลง state/orphan/log/ผลลัพธ์ และข้อความ error ถูก scrub ก่อนออกไปที่ไหน
const { CloudflareError, isValidTunnelId } = require('./cloudflare');
const { preflightAutoTunnel, PreflightError } = require('./cloudflare-preflight');
const realState = require('./cloudflare-state');

const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// ไม่รวม . และ / เพื่อไม่ทำลายชื่อ hostname/image ในข้อความ error (token ที่รู้ค่าถูกลบตรงๆ อยู่แล้ว; ตัวนี้เป็นตาข่ายกันสตริงหน้าตาเป็น token ที่ไม่รู้ค่า)
const TOKENISH_RE = /[A-Za-z0-9_\-+=]{24,}/g;
const MAX_MESSAGE = 300;
const DEFINITE_CODES = new Set(['invalid-id', 'invalid-argument', 'no-token']);

// ลบ token ที่รู้ค่า + สตริงยาวหน้าตาเป็น token ออกจากข้อความของ exception (ข้อความที่เราประกอบเองไม่ผ่านที่นี่)
function scrub(text, secrets = []) {
  let s = String(text === undefined || text === null ? '' : text);
  for (const secret of secrets) {
    if (secret) s = s.split(secret).join('[redacted]');
  }
  s = s.replace(TOKENISH_RE, '[redacted]');
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s;
}

// คำขอสร้างที่ Cloudflare "ปฏิเสธชัดเจน" = ไม่มีอะไรถูกสร้าง; อย่างอื่น (timeout/5xx/error แปลก) = ผลไม่แน่ชัด ต้องตรวจสถานะจริง
function isDefiniteRejection(err) {
  if (!(err instanceof CloudflareError)) return false;
  if (DEFINITE_CODES.has(err.code)) return true;
  return err.code === 'http' && err.status >= 400 && err.status < 500;
}

function createAutoTunnelService({ settings, client, state = realState, ops, logger } = {}) {
  const enabled = Boolean(settings && settings.enabled);

  function requireEnabled() {
    if (!enabled) throw new PreflightError('Cloudflare auto-tunnel is disabled', 403, 'disabled');
  }

  function isEnabled() {
    return enabled;
  }

  // ข้อมูลที่หน้าเว็บรู้ได้ (ไม่ลับ): เปิดอยู่ไหม + ชื่อ zone
  function features() {
    return enabled ? { cloudflareAutoTunnel: true, cloudflareZone: settings.zoneName } : { cloudflareAutoTunnel: false };
  }

  async function preflight(botName, hostname) {
    requireEnabled();
    return preflightAutoTunnel({ client, state, botName, hostname, zoneName: settings.zoneName, reserved: settings.reserved });
  }

  function validatePlan(botName, plan) {
    const bad = (why) => new PreflightError(`Invalid auto-tunnel plan: ${why}`, 400, 'invalid-plan');
    if (typeof botName !== 'string' || !BOT_NAME_RE.test(botName)) throw bad('bot name');
    if (!plan || typeof plan !== 'object') throw bad('missing plan');
    if (plan.tunnelName !== `netguard-${botName}`) throw bad('tunnel name does not match the bot');
    if (plan.service !== `http://netguard-${botName}:3000`) throw bad('service does not match the bot');
    const suffix = `.${settings.zoneName}`;
    if (typeof plan.hostname !== 'string' || !plan.hostname.endsWith(suffix) || plan.hostname.length <= suffix.length) throw bad('hostname');
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.hostname.slice(0, -suffix.length))) throw bad('hostname');
  }

  // ลองทุกขั้นที่ขอ ตามลำดับ container → DNS → tunnel → token ใน .env แม้ขั้นก่อนหน้าล้ม; คืนชื่อขั้นที่ล้ม
  // 'dns' ที่ไม่มี DNS record id = ไม่มีอะไรต้องลบ (ข้าม)
  async function runSteps(ctx, wanted) {
    const failed = [];
    const attempt = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        failed.push(name);
        logger.warn(`Cloudflare auto-tunnel: cleanup step "${name}" failed for "${ctx.botName}": ${scrub(err && err.message, ctx.secrets)}`);
      }
    };
    if (wanted.has('container')) await attempt('container', () => ops.removeTunnelContainer(ctx.botName));
    if (wanted.has('dns') && ctx.dnsRecordId) {
      await attempt('dns', () => client.deleteDnsRecord(ctx.dnsRecordId, { hostname: ctx.hostname, tunnelId: ctx.tunnelId }));
    }
    if (wanted.has('tunnel')) await attempt('tunnel', () => client.deleteTunnel(ctx.tunnelId, { expectedName: `netguard-${ctx.botName}` }));
    if (wanted.has('env-token')) await attempt('env-token', () => ops.clearEnvToken(ctx.botName));
    return failed;
  }

  // ── ย้อนกลับ/ล้างทรัพยากร ────────────────────────────────────────────────────
  // ctx: { botName, hostname, tunnelId, dnsRecordId, containerAttempted, envAttempted, secrets }
  // ลองครบทุกขั้นเสมอ; ขั้นที่ล้มลง orphan (พร้อม leftovers) แล้วจึงลบ state; ลง orphan ไม่ได้ = เก็บ state ไว้
  async function rollback(ctx, why) {
    const result = { ok: true, failed: [], orphaned: false };
    if (ctx.unknown) result.unknown = true;
    if (!ctx.tunnelId) return result;

    const wanted = new Set(['tunnel']);
    if (ctx.containerAttempted) wanted.add('container');
    if (ctx.dnsRecordId) wanted.add('dns');
    if (ctx.envAttempted) wanted.add('env-token');
    const failed = await runSteps(ctx, wanted);

    if (failed.length > 0) {
      result.ok = false;
      result.failed = failed;
      try {
        state.addOrphan({
          botName: ctx.botName,
          hostname: ctx.hostname,
          tunnelId: ctx.tunnelId,
          dnsRecordId: failed.includes('dns') ? ctx.dnsRecordId : null,
          accountId: settings.accountId,
          zoneId: settings.zoneId,
          reason: `${why}; cleanup incomplete: ${failed.join(',')}`,
          leftovers: failed,
        });
        result.orphaned = true;
        logger.warn(`Cloudflare auto-tunnel: recorded leftovers (${failed.join(', ')}) for "${ctx.botName}" as an orphan — clean up from the orphan list`);
      } catch (err) {
        logger.error(`Cloudflare auto-tunnel: could not record orphan for "${ctx.botName}" (${scrub(err && err.message, ctx.secrets)}) — keeping its cloudflare state file`);
        return result; // เก็บ state ไว้ ไม่ให้ข้อมูลที่ใช้ตามเก็บหาย
      }
    }
    try {
      state.deleteState(ctx.botName);
    } catch (err) {
      logger.error(`Cloudflare auto-tunnel: could not remove state file for "${ctx.botName}": ${scrub(err && err.message, ctx.secrets)}`);
    }
    return result;
  }

  // ── ตรวจสถานะจริงหลังคำขอสร้างที่ผลไม่แน่ชัด ─────────────────────────────────────
  async function adoptTunnelAfterAmbiguousCreate(ctx, tunnelName) {
    try {
      const found = await client.findTunnelsByName(tunnelName);
      if (found.length === 1 && isValidTunnelId(found[0].id)) {
        ctx.tunnelId = found[0].id; // preflight เพิ่งยืนยันว่าไม่มีชื่อนี้ → ตัวที่พบคือของคำขอเรา
      } else if (found.length > 1) {
        ctx.unknown = true;
        logger.error(`Cloudflare auto-tunnel: several tunnels named "${tunnelName}" found after an uncertain create — not deleting any, check Cloudflare manually`);
      }
    } catch (err) {
      ctx.unknown = true;
      logger.error(`Cloudflare auto-tunnel: could not check whether tunnel "${tunnelName}" was created (${scrub(err && err.message, ctx.secrets)}) — check Cloudflare manually`);
    }
  }

  async function adoptDnsAfterAmbiguousCreate(ctx) {
    try {
      const records = await client.findDnsRecords(ctx.hostname);
      const ours = `${ctx.tunnelId.toLowerCase()}.cfargotunnel.com`;
      const mine = records.find((r) => r.type === 'CNAME' && typeof r.content === 'string' && r.content.toLowerCase() === ours);
      if (mine) ctx.dnsRecordId = mine.id;
    } catch (err) {
      ctx.unknown = true;
      logger.error(`Cloudflare auto-tunnel: could not check whether DNS for "${ctx.hostname}" was created (${scrub(err && err.message, ctx.secrets)}) — check Cloudflare manually`);
    }
  }

  // ── provision ────────────────────────────────────────────────────────────────
  async function provision(botName, plan) {
    requireEnabled();
    validatePlan(botName, plan);
    const ctx = {
      botName, hostname: plan.hostname, tunnelId: null, dnsRecordId: null,
      containerAttempted: false, envAttempted: false, unknown: false, secrets: [],
    };
    let step = 'create-tunnel';
    try {
      let tunnel;
      try {
        tunnel = await client.createTunnel(plan.tunnelName);
      } catch (err) {
        if (!isDefiniteRejection(err)) await adoptTunnelAfterAmbiguousCreate(ctx, plan.tunnelName);
        throw err;
      }
      ctx.tunnelId = tunnel.id;
      if (tunnel.token) ctx.secrets.push(tunnel.token);

      step = 'save-state';
      state.writeState(botName, {
        accountId: settings.accountId, zoneId: settings.zoneId, tunnelId: tunnel.id, hostname: plan.hostname, dnsRecordId: null, step: 'tunnel-created',
      });

      step = 'set-ingress';
      await client.putIngress(tunnel.id, { hostname: plan.hostname, service: plan.service });
      step = 'save-state';
      state.updateState(botName, { step: 'ingress-set' });

      step = 'create-dns';
      let record;
      try {
        record = await client.createCname({ hostname: plan.hostname, tunnelId: tunnel.id, comment: `managed-by=netguard-manager bot=${botName}` });
      } catch (err) {
        if (!isDefiniteRejection(err)) await adoptDnsAfterAmbiguousCreate(ctx);
        throw err;
      }
      ctx.dnsRecordId = record.id;
      step = 'save-state';
      state.updateState(botName, { dnsRecordId: record.id, step: 'dns-created' });

      let token = tunnel.token;
      if (!token) {
        step = 'get-token';
        token = await client.getTunnelToken(tunnel.id);
        ctx.secrets.push(token);
      }

      step = 'write-env';
      ctx.envAttempted = true;
      await ops.writeEnvToken(botName, token);

      step = 'start-container';
      ctx.containerAttempted = true;
      await ops.startTunnelContainer(botName, token);

      step = 'save-state';
      state.updateState(botName, { step: 'container-started' });
      state.updateState(botName, { step: 'complete' });

      logger.info(`Cloudflare auto-tunnel: tunnel ready for "${botName}" (${plan.hostname})`);
      return { status: 'ok', hostname: plan.hostname, tunnelId: tunnel.id };
    } catch (err) {
      const message = scrub(err && err.message, ctx.secrets);
      logger.warn(`Cloudflare auto-tunnel: step ${step} failed for "${botName}" (${plan.hostname}): ${message}`);
      const rolled = await rollback(ctx, `provision failed at ${step}`);
      return { status: 'failed', step, message, hostname: plan.hostname, rollback: rolled };
    }
  }

  // ── ลบบอท / รายการค้าง ───────────────────────────────────────────────────────
  // state/orphan ที่บันทึกไว้ต้องเป็นของ account+zone เดียวกับที่ตั้งอยู่ตอนนี้ — ไม่งั้น client (ผูกกับ account/zone ปัจจุบัน) จะลบผิดที่/ได้ 404 แล้วเข้าใจผิด
  function assertSameAccount(record) {
    if (record.accountId !== settings.accountId || record.zoneId !== settings.zoneId) {
      throw new PreflightError('Stored Cloudflare account/zone differs from the configured one — refusing to touch it', 409, 'account-mismatch');
    }
  }

  // ล้าง Cloudflare ของบอทตอนลบบอท: container → DNS → tunnel → token ใน .env → state; ขั้นที่ล้มลง orphan (ดู rollback)
  async function teardown(botName, { reason = 'teardown' } = {}) {
    requireEnabled();
    const st = state.readState(botName); // state เสีย → โยน corrupt (ไม่ลบอะไรมั่ว)
    if (!st) return { status: 'none' };
    assertSameAccount(st);
    const ctx = {
      botName, hostname: st.hostname, tunnelId: st.tunnelId, dnsRecordId: st.dnsRecordId,
      containerAttempted: true, envAttempted: true, unknown: false, secrets: [],
    };
    const rolled = await rollback(ctx, reason);
    return { status: rolled.ok ? 'removed' : 'partial', rollback: rolled };
  }

  // ผู้ใช้เลือกลบบอทโดยไม่ลบ Cloudflare (หรือ flag ปิดอยู่) และจะลบไฟล์บอท: ลงรายการค้างก่อน ไม่ให้ tunnel/DNS หายจากการติดตามเงียบๆ
  // ไม่ต้องใช้ client จึงใช้ได้แม้ flag ปิด; ลง orphan ไม่ได้ = โยน error และไม่ลบ state
  function recordKept(botName) {
    const st = state.readState(botName);
    if (!st) return { recorded: false };
    state.addOrphan({
      botName,
      hostname: st.hostname,
      tunnelId: st.tunnelId,
      dnsRecordId: st.dnsRecordId,
      accountId: st.accountId,
      zoneId: st.zoneId,
      reason: 'kept at bot removal (Cloudflare resources were not deleted)',
      leftovers: st.dnsRecordId ? ['dns', 'tunnel'] : ['tunnel'],
    });
    state.deleteState(botName);
    return { recorded: true };
  }

  function listOrphans() {
    return state.listOrphans();
  }

  // ทำขั้นที่ยังค้างของรายการ orphan ต่อ; สำเร็จหมด = ลบรายการ, ไม่หมด = อัปเดตให้เหลือเฉพาะที่ยังค้าง
  async function cleanupOrphan(tunnelId) {
    requireEnabled();
    if (!isValidTunnelId(tunnelId)) throw new PreflightError('Invalid tunnel id', 400, 'invalid-tunnel-id');
    const entry = state.listOrphans().find((o) => o.tunnelId === tunnelId);
    if (!entry) throw new PreflightError('No such leftover entry', 404, 'not-found');
    assertSameAccount(entry);

    const wanted = new Set(entry.leftovers.length > 0 ? entry.leftovers : ['container', 'dns', 'tunnel', 'env-token']);
    const ctx = { botName: entry.botName, hostname: entry.hostname, tunnelId, dnsRecordId: entry.dnsRecordId, secrets: [] };
    const failed = await runSteps(ctx, wanted);
    if (failed.length === 0) {
      state.removeOrphan(tunnelId);
      logger.info(`Cloudflare auto-tunnel: leftovers for "${entry.botName}" cleaned up`);
      return { status: 'cleaned', failed: [] };
    }
    state.addOrphan({
      botName: entry.botName,
      hostname: entry.hostname,
      tunnelId,
      dnsRecordId: failed.includes('dns') ? entry.dnsRecordId : null,
      accountId: entry.accountId,
      zoneId: entry.zoneId,
      reason: `cleanup retry incomplete: ${failed.join(',')}`,
      leftovers: failed,
    });
    return { status: 'partial', failed };
  }

  return { isEnabled, features, preflight, provision, teardown, recordKept, listOrphans, cleanupOrphan };
}

module.exports = { createAutoTunnelService, scrub, isDefiniteRejection };
