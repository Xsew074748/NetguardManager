// Audit log modal (ดูอย่างเดียว) + banner เตือนรหัสผ่านสั้น — ข้อมูลทุกช่องถูก escape ก่อนแสดง (ชื่อ/ข้อความมาจากผู้ใช้/เครือข่าย)
const auditModal = document.getElementById('auditModal');
const auditBody = document.getElementById('auditBody');

function auditFmtTs(ts) {
  return new Date(ts * 1000).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' });
}

function auditDetailText(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' · ');
}

async function loadAudit() {
  auditBody.textContent = 'Loading...';
  try {
    const data = await apiGetAudit({
      action: document.getElementById('auditAction').value,
      result: document.getElementById('auditResult').value,
      limit: '200',
    });
    if (!data.rows.length) { auditBody.innerHTML = '<div class="stats-empty">ยังไม่มีรายการ</div>'; return; }
    auditBody.innerHTML = `
      <div class="stat-chart-note">แสดง ${data.rows.length} จาก ${data.total} รายการล่าสุด · actor = ตัวย่อของ session (ใช้รหัสผ่านร่วมกัน ระบุตัวบุคคลไม่ได้)</div>
      <table class="stat-table audit-table">
        <thead><tr><th>เวลา</th><th>action</th><th>เป้าหมาย</th><th>ผล</th><th>actor / IP</th></tr></thead>
        <tbody>${data.rows.map((r) => `
          <tr>
            <td>${escapeHtml(auditFmtTs(r.ts))}</td>
            <td>${escapeHtml(r.action)}<div class="audit-detail">${escapeHtml(auditDetailText(r.detail))}</div></td>
            <td>${escapeHtml(r.target || '—')}</td>
            <td class="res-${escapeHtml(r.result)}">${escapeHtml(r.result)}</td>
            <td>${escapeHtml(r.actor || '—')}<div class="audit-detail">${escapeHtml(r.ip || '')}</div></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    auditBody.innerHTML = `<div class="form-error show">โหลด audit log ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById('auditBtn').addEventListener('click', () => { auditModal.classList.add('show'); loadAudit(); });
document.getElementById('auditRefresh').addEventListener('click', loadAudit);
document.getElementById('auditAction').addEventListener('change', loadAudit);
document.getElementById('auditResult').addEventListener('change', loadAudit);
document.getElementById('auditModalClose').addEventListener('click', () => auditModal.classList.remove('show'));
auditModal.addEventListener('click', (e) => { if (e.target === auditModal) auditModal.classList.remove('show'); });

// banner เตือนรหัสผ่านสั้น (เตือนอย่างเดียว ไม่บังคับ)
apiAuthStatus().then((s) => {
  if (s && s.weakPassword) document.getElementById('weakPasswordBanner').hidden = false;
}).catch(() => { /* ไม่มี banner ก็ไม่เป็นไร */ });
