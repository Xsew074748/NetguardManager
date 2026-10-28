// ฟังก์ชันล้วน (ไม่แตะ DOM) ของฟีเจอร์ "สร้าง Cloudflare Tunnel อัตโนมัติ" — แยกออกมาเพื่อทดสอบได้ใน vm (tests/cloudflare-ui.test.js)
// หลักการ: flag ปิด (cloudflareFeature.cloudflareAutoTunnel = false) → คำขอและข้อความเหมือนเดิมทุกอย่าง
// ข้อความ error คืน duration 0 (toast ค้างจนกว่าจะปิด) เหมือนจุด error อื่นของหน้านี้ — ผู้เรียกส่งต่อให้ showToast ตรงๆ

const CF_LEFTOVER_LABELS = {
  container: 'container cloudflared',
  dns: 'DNS record',
  tunnel: 'Tunnel',
  'env-token': 'token ใน .env',
};

// payload ของ POST /api/bots — ไม่ติ๊ก auto (หรือ flag ปิด) = payload เดิมเป๊ะ; ติ๊ก auto = ไม่ส่ง token (ใช้อย่างใดอย่างหนึ่ง)
function buildCreatePayload({ name, port, tunnelToken, companyName, autoTunnel, hostname, featureOn }) {
  const payload = { name, port };
  const auto = !!(autoTunnel && featureOn);
  if (!auto && tunnelToken) payload.tunnelToken = tunnelToken;
  if (companyName) payload.companyName = companyName;
  if (auto) {
    payload.autoTunnel = true;
    payload.hostname = String(hostname || '').trim().toLowerCase();
  }
  return payload;
}

// ช่อง hostname ในฟอร์มมี .<zone> ต่อท้ายตายตัว ผู้ใช้พิมพ์แค่ชื่อ (label) — ชื่อเต็มประกอบที่ autoHostnameFromInput แล้วส่ง API เหมือนเดิม
// label ตรงกับกฎของ server (services/cloudflare-auto.js validatePlan): a-z0-9 และ - ไม่ขึ้นต้น/ลงท้ายด้วย - ยาวไม่เกิน 63
const AUTO_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// trim + ตัวพิมพ์เล็ก "ก่อน" แล้วตัด .<zone> ท้ายสุดครั้งเดียว (ผู้ใช้วางชื่อเต็มได้ แต่ซ้อน suffix สองชั้นไม่ได้)
function autoLabelFromInput(input, zoneName) {
  let v = String(input == null ? '' : input).trim().toLowerCase();
  const zone = String(zoneName || '').toLowerCase();
  if (zone && v.endsWith(`.${zone}`)) v = v.slice(0, -(zone.length + 1));
  return v;
}

// ตรวจเบื้องต้นฝั่งหน้าเว็บให้ผู้ใช้เห็นเร็ว (server ตรวจจริงอีกชั้น: รูปแบบ, ชื่อสงวน, ชนกับ DNS/tunnel เดิม) — คืน '' ถ้าผ่าน
function autoLabelProblem(input, zoneName) {
  if (!zoneName) return 'ยังไม่ทราบ zone ของ Cloudflare — โหลดหน้าใหม่แล้วลองอีกครั้ง';
  const label = autoLabelFromInput(input, zoneName);
  if (!label) return 'กรอกชื่อที่ต้องการ (เช่น office)';
  if (label.includes('.')) return `พิมพ์เฉพาะชื่อชั้นเดียว ห้ามมีจุด — ระบบเติม .${zoneName} ให้เอง (เช่น office)`;
  if (!AUTO_LABEL_RE.test(label)) return 'ชื่อใช้ได้เฉพาะ a-z, 0-9 และ - (ห้ามขึ้นต้น/ลงท้ายด้วย -, ไม่เกิน 63 ตัว; ห้าม https://, เครื่องหมายพิเศษ, ช่องว่าง)';
  return '';
}

// ชื่อเต็มที่ส่ง API (เรียกหลัง autoLabelProblem ผ่านแล้ว)
function autoHostnameFromInput(input, zoneName) {
  return `${autoLabelFromInput(input, zoneName)}.${zoneName}`;
}

// ชื่อเดิม: ใช้กฎเดียวกับ autoLabelProblem (รับทั้งชื่อสั้นและชื่อเต็ม) — ไม่เก็บกฎสองชุด
function autoHostnameProblem(hostname, zoneName) {
  return autoLabelProblem(hostname, zoneName);
}

function cfRollbackText(rollback) {
  if (!rollback) return '';
  if (rollback.unknown) return 'ตรวจสถานะใน Cloudflare ไม่ได้ ต้องตรวจเองใน dashboard ว่ามี tunnel/DNS ค้างหรือไม่';
  if (rollback.ok) return 'ย้อนกลับสิ่งที่สร้างใน Cloudflare แล้ว';
  if (rollback.orphaned) return 'ยังมีของค้างใน Cloudflare — ดูที่ปุ่ม "Cloudflare ค้าง"';
  return 'ล้างไม่ครบและบันทึกรายการค้างไม่ได้ — ดู log ของ Manager';
}

// toast หลังสร้างบอท/ลองสร้าง tunnel ใหม่ — ไม่มี tunnel ในผล (ทางเดิม) = null
function tunnelToastFor(botName, tunnel) {
  if (!tunnel) return null;
  if (tunnel.status === 'ok') {
    // status ok = สร้าง tunnel/DNS ครบและเริ่ม cloudflared แล้วเท่านั้น — ยังไม่ได้ตรวจว่าต่อกับ Cloudflare ได้จริง ถ้อยคำจึงต้องไม่สื่อว่าใช้งานได้จริงแล้ว
    return { type: 'success', text: `สร้าง Tunnel ของ "${botName}" ที่ ${tunnel.hostname} และเริ่ม cloudflared แล้ว — ยังไม่ได้ตรวจว่าเชื่อมต่อกับ Cloudflare ได้ ดูผลที่เมนู "ดู Tunnel Log"` };
  }
  const rolled = cfRollbackText(tunnel.rollback);
  return {
    type: 'error',
    duration: 0,
    text: `บอท "${botName}" ถูกสร้างแล้ว แต่สร้าง Tunnel อัตโนมัติไม่สำเร็จ (ขั้น ${tunnel.step}): ${tunnel.message}${rolled ? ` — ${rolled}` : ''} — กด "สร้าง Tunnel อัตโนมัติ" ที่เมนูของบอทเพื่อลองใหม่`,
  };
}

// ตัวเลือกตอนลบบอท: บอทที่ไม่มี Cloudflare state → undefined (คำขอเดิม); มี state → ตามช่องติ๊กเมื่อ flag เปิด, flag ปิด = false ชัดเจน
function removeRequestOptions({ bot, featureOn, checked }) {
  if (!bot || !bot.cloudflare) return { deleteCloudflare: undefined };
  return { deleteCloudflare: featureOn ? !!checked : false };
}

function removeToast(name, deleteFiles, response) {
  const base = `ลบ bot "${name}" สำเร็จ${deleteFiles ? ' (รวมไฟล์)' : ''}`;
  const cf = response && response.cloudflare;
  if (!cf) return { text: base, type: 'success' };
  if (cf.status === 'removed') return { text: `${base} และลบ Tunnel/DNS ใน Cloudflare แล้ว`, type: 'success' };
  if (cf.status === 'partial') {
    const orphaned = cf.rollback && cf.rollback.orphaned;
    return {
      type: 'error',
      duration: 0,
      text: `${base} แต่ลบใน Cloudflare ได้ไม่ครบ — ${orphaned ? 'บางส่วนค้างอยู่ ดูที่ปุ่ม "Cloudflare ค้าง"' : 'บันทึกรายการค้างไม่ได้ ดู log ของ Manager'}`,
    };
  }
  if (cf.status === 'kept') {
    return { type: 'info', text: `${base} — Tunnel/DNS ใน Cloudflare ยังอยู่${deleteFiles ? ' (บันทึกใน "รายการค้าง" แล้ว)' : ''}` };
  }
  return { text: base, type: 'success' };
}

function cfLeftoverText(leftovers) {
  const list = leftovers && leftovers.length > 0 ? leftovers : Object.keys(CF_LEFTOVER_LABELS);
  return list.map((k) => CF_LEFTOVER_LABELS[k] || k).join(', ');
}

function orphanSummary(entry) {
  return {
    title: `${entry.botName} — ${entry.hostname}`,
    detail: `ค้าง: ${cfLeftoverText(entry.leftovers)}`,
  };
}

function cleanupToast(result) {
  if (result && result.status === 'cleaned') return { type: 'success', text: 'ล้างของที่ค้างใน Cloudflare เรียบร้อย' };
  return { type: 'error', duration: 0, text: `ล้างได้ไม่ครบ ยังค้าง: ${cfLeftoverText(result && result.failed)}` };
}
