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

// ตรวจเบื้องต้นฝั่งหน้าเว็บให้ผู้ใช้เห็นเร็ว (server ตรวจจริงอีกชั้น: รูปแบบ, ชื่อสงวน, ชนกับ DNS/tunnel เดิม) — คืน '' ถ้าผ่าน
function autoHostnameProblem(hostname, zoneName) {
  if (!zoneName) return 'ยังไม่ทราบ zone ของ Cloudflare — โหลดหน้าใหม่แล้วลองอีกครั้ง';
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return 'กรอก hostname ที่ต้องการ';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) {
    return 'hostname ใช้ได้เฉพาะ a-z, 0-9, - และจุด (ห้าม https://, เครื่องหมายพิเศษ, ช่องว่าง)';
  }
  const suffix = `.${zoneName}`;
  if (!h.endsWith(suffix)) return `hostname ต้องเป็น <ชื่อ>${suffix}`;
  if (h.slice(0, -suffix.length).includes('.')) return `ต้องมีชื่อหน้า ${zoneName} เพียงชั้นเดียว (เช่น office${suffix})`;
  return '';
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
