function showToast(message, type) {
  const el = document.createElement('div');
  el.className = `toast ${type || 'info'}`;

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.appendChild(msg);

  const progress = document.createElement('div');
  progress.className = 'toast-progress';
  el.appendChild(progress);

  toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4000);
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function easeOutQuad(t) {
  return t * (2 - t);
}

let numAnimSeq = 0;
function animateNumber(el, from, to, duration) {
  if (from === to) return;
  if (prefersReducedMotion()) { el.textContent = to; return; }
  duration = duration || 500;
  const myId = ++numAnimSeq;
  el._numAnimId = myId;
  const startTime = performance.now();
  function tick(now) {
    if (el._numAnimId !== myId) return;
    const progress = Math.min((now - startTime) / duration, 1);
    el.textContent = Math.round(from + (to - from) * easeOutQuad(progress));
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function setSummaryNumber(el, newValue) {
  el.classList.remove('skeleton-num');
  const oldValue = Number(el.dataset.value);
  el.dataset.value = newValue;
  if (Number.isNaN(oldValue)) { el.textContent = newValue; return; }
  animateNumber(el, oldValue, newValue, 500);
}

function flashSummaryCards() {
  document.querySelectorAll('.summary-card').forEach((card) => {
    card.classList.remove('flash-update');
    void card.offsetWidth; // restart animation ถ้า flash ถี่กว่ารอบก่อนจบ
    card.classList.add('flash-update');
    card.addEventListener('animationend', () => card.classList.remove('flash-update'), { once: true });
  });
}

function statusClass(state) {
  if (state === 'running') return 'running';
  if (state === 'exited' || state === 'dead') return 'stopped';
  return 'other';
}

function statusLabel(state) {
  if (state === 'running') return 'Running';
  if (state === 'exited') return 'Stopped';
  return state || 'Unknown';
}

function tunnelIcon(tunnel) {
  if (!tunnel || !tunnel.exists) return '';
  const ok = tunnel.state === 'running';
  const title = ok ? 'Tunnel เชื่อมต่ออยู่' : 'Tunnel ล่ม';
  return `<span class="tunnel-icon ${ok ? 'ok' : 'down'}" title="${title}">&#128279;</span>`;
}

// ทำงานปกติ = state running + health ok + tunnel (ถ้ามี) ต้องไม่ล่ม
// มีปัญหา = stopped/other, unhealthy, หรือ tunnel ล่ม
function botStatus(bot) {
  if (bot.state !== 'running') return 'problem';
  if (!bot.health || bot.health.ok !== true) return 'problem';
  if (bot.tunnel && bot.tunnel.exists && bot.tunnel.state !== 'running') return 'problem';
  return 'healthy';
}

function contractSoon(bot) {
  const days = daysUntil(bot.meta && bot.meta.contractEnd);
  return days !== null && days < 30;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function contractBadge(contractEnd) {
  const days = daysUntil(contractEnd);
  if (days === null) return '';
  if (days < 0) return '<span class="contract-badge contract-expired">&#9888; หมดสัญญาแล้ว</span>';
  if (days < 30) return '<span class="contract-badge contract-warning">&#9888; ใกล้หมดสัญญา</span>';
  return '';
}

function uptimeCell(pct, animate) {
  if (pct === null || pct === undefined) return '<span class="uptime-value uptime-na">&mdash;</span>';
  let cls, fillCls;
  if (pct >= 99.5) { cls = 'uptime-good'; fillCls = 'fill-good'; }
  else if (pct >= 95) { cls = 'uptime-warn'; fillCls = 'fill-warn'; }
  else { cls = 'uptime-bad'; fillCls = 'fill-bad'; }
  const target = Math.min(100, Math.max(0, pct));
  const widthStyle = animate ? 'width:0%' : `width:${target}%`;
  return `
    <div class="uptime-cell-inner">
      <span class="uptime-value ${cls}">${pct.toFixed(1)}%</span>
      <div class="uptime-bar"><div class="uptime-bar-fill ${fillCls}" style="${widthStyle}" data-target-width="${target}"></div></div>
    </div>
  `;
}

// เรียกหลัง insert DOM แล้วเท่านั้น — ให้ browser paint ที่ width:0% ไปเฟรมนึงก่อน
// แล้วค่อยเปลี่ยนเป็นค่าจริง ไม่งั้น transition จะไม่ทำงาน (รวบเป็นเฟรมเดียว)
function animateUptimeBar(cell) {
  const fill = cell.querySelector('.uptime-bar-fill[data-target-width]');
  if (!fill) return;
  const target = fill.dataset.targetWidth;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = `${target}%`;
    });
  });
}

function botCell(bot, name) {
  const meta = bot.meta || {};
  const badge = contractBadge(meta.contractEnd);
  if (!meta.companyName) {
    return `<div class="bot-cell-company">${escapeHtml(name)}${badge}</div>`;
  }
  const tooltipParts = [meta.contactName, meta.contactPhone].filter(Boolean);
  const tooltip = tooltipParts.join(' ');
  const titleAttr = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  return `
    <div class="bot-cell-company"${titleAttr}>${escapeHtml(meta.companyName)}${badge}</div>
    <div class="bot-cell-name">${escapeHtml(name)}</div>
  `;
}

function infoCell(bot) {
  const portPart = bot.port ? `<span class="port-value">${bot.port}</span>` : '-';
  let monitorsPart = '-';
  if (bot.state === 'running') {
    monitorsPart = bot.health && bot.health.ok
      ? `${(bot.health.monitorsLoaded && bot.health.monitorsLoaded.length) || 0} monitors`
      : (bot.health ? escapeHtml(bot.health.reason || 'offline') : '-');
  }
  return `<span class="info-cell-text">${portPart} &middot; ${monitorsPart}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function botDisplayName(bot) {
  return bot.name.replace(/^netguard-/, '');
}

function renderSummaryBar(bots) {
  setSummaryNumber(document.getElementById('countTotal'), bots.length);
  setSummaryNumber(document.getElementById('countHealthy'), bots.filter((b) => botStatus(b) === 'healthy').length);
  setSummaryNumber(document.getElementById('countProblem'), bots.filter((b) => botStatus(b) === 'problem').length);
  setSummaryNumber(document.getElementById('countContract'), bots.filter(contractSoon).length);
}

function applyFilters(bots) {
  let list = bots;
  if (activeCardFilter === 'healthy') list = list.filter((b) => botStatus(b) === 'healthy');
  if (activeCardFilter === 'problem')  list = list.filter((b) => botStatus(b) === 'problem');
  if (activeCardFilter === 'contract') list = list.filter(contractSoon);

  const q = searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((b) => {
      const name = botDisplayName(b).toLowerCase();
      const company = ((b.meta && b.meta.companyName) || '').toLowerCase();
      const contact = ((b.meta && b.meta.contactName) || '').toLowerCase();
      return name.includes(q) || company.includes(q) || contact.includes(q);
    });
  }
  return list;
}

function rowTemplate(bot, animIndex) {
  const running = bot.state === 'running';
  const name = botDisplayName(bot);
  const hasTunnel = !!(bot.tunnel && bot.tunnel.exists);
  const id = escapeHtml(bot.id);
  const n = escapeHtml(name);

  const mainActionBtn = running
    ? `<button class="btn-icon btn-stop btn-main-action" data-action="stop" data-id="${id}">&#9208; Stop</button>`
    : `<button class="btn-icon btn-start btn-main-action" data-action="start" data-id="${id}">&#9654; Start</button>`;
  const kebabToggleAction = running
    ? `<button class="kebab-item" role="menuitem" data-action="stop" data-id="${id}">&#9208; Stop</button>`
    : `<button class="kebab-item" role="menuitem" data-action="start" data-id="${id}">&#9654; Start</button>`;

  const shouldAnimateRow = animIndex !== undefined && animIndex !== -1;
  const rowClass = shouldAnimateRow ? ' row-in' : '';
  const rowStyle = (shouldAnimateRow && animIndex < 10) ? ` style="--i:${animIndex}"` : '';

  return `
    <tr data-id="${id}" data-name="${n}" class="clickable-row${rowClass}" tabindex="0" role="button" aria-label="ดูสถิติของ ${n}"${rowStyle}>
      <td>${botCell(bot, name)}</td>
      <td>
        <span class="status">
          <span class="status-dot ${statusClass(bot.state)}"></span>
          ${statusLabel(bot.state)}
          ${tunnelIcon(bot.tunnel)}
        </span>
      </td>
      <td class="uptime-cell">${uptimeCell(null)}</td>
      <td class="col-info">${infoCell(bot)}</td>
      <td>
        <div class="row-actions">
          ${mainActionBtn}
          <div class="kebab-wrap">
            <button class="btn-icon btn-kebab" type="button" data-kebab-toggle data-id="${id}" aria-haspopup="true" aria-expanded="false" title="เมนูเพิ่มเติม">&#8942;</button>
            <div class="kebab-menu" role="menu">
              ${kebabToggleAction}
              <button class="kebab-item" role="menuitem" data-action="restart" data-id="${id}">&#8635; Restart</button>
              <button class="kebab-item" role="menuitem" data-action="log" data-id="${id}" data-name="${n}">&#128196; ดู Log</button>
              <button class="kebab-item" role="menuitem" data-action="edit-meta" data-name="${n}">&#9998; แก้ไขข้อมูลลูกค้า</button>
              <button class="kebab-item" role="menuitem" data-action="config" data-id="${id}" data-name="${n}">&#9881; ตั้งค่า (.env)</button>
              ${!hasTunnel ? `<button class="kebab-item" role="menuitem" data-action="tunnel-add" data-name="${n}">&#128279; เพิ่ม Tunnel</button>` : ''}
              ${hasTunnel ? `<button class="kebab-item" role="menuitem" data-action="tunnel-log" data-name="${n}">&#128279; ดู Tunnel Log</button>` : ''}
              ${hasTunnel ? `<button class="kebab-item" role="menuitem" data-action="tunnel-remove" data-name="${n}">&#128279; ลบ Tunnel</button>` : ''}
              <div class="kebab-divider"></div>
              <button class="kebab-item kebab-danger" role="menuitem" data-action="remove" data-id="${id}" data-name="${n}">&#128465; ลบ Bot</button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderTable() {
  if (!botsCache.length) {
    botsCard.style.display = 'none';
    emptyStateNone.style.display = 'block';
    emptyStateFiltered.style.display = 'none';
    return;
  }

  const filtered = applyFilters(botsCache);

  if (!filtered.length) {
    botsCard.style.display = 'none';
    emptyStateNone.style.display = 'none';
    emptyStateFiltered.style.display = 'block';
    return;
  }

  botsCard.style.display = '';
  emptyStateNone.style.display = 'none';
  emptyStateFiltered.style.display = 'none';

  // เล่น row-in animation เฉพาะตอนชุด bot ที่แสดงเปลี่ยนไปจริง (bot ถูกเพิ่ม/ลบ/filter เปลี่ยน)
  // ไม่เล่นซ้ำทุก auto-refresh (10 วิ) ที่ชุดเดิม เพราะจะกระพริบน่ารำคาญ
  const ids = filtered.map((b) => b.id).join(',');
  const shouldAnimate = ids !== lastRenderedRowIds;
  lastRenderedRowIds = ids;

  tbody.innerHTML = filtered.map((bot, i) => rowTemplate(bot, shouldAnimate ? i : -1)).join('');
  filtered.forEach((bot) => loadBotUptime(bot, shouldAnimate));
}

// ── Summary card sparklines (7 วันล่าสุด, รวมข้อมูลฝั่ง client จาก daily stats ของทุก bot) ──
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// dailyResults: [{ name, rows }] — rows คือผลจาก /stats/daily?days=7 ของแต่ละ bot
// รวมเป็น series ต่อวัน โดยใช้ union ของวันที่ที่ปรากฏจริง (ไม่เดา timezone เอง)
function buildSparklineSeries(dailyResults) {
  const dayMap = new Map();
  dailyResults.forEach(({ rows }) => {
    rows.forEach((row) => {
      if (!dayMap.has(row.day)) dayMap.set(row.day, { botCount: 0, uptimeSum: 0, uptimeCount: 0, problemCount: 0 });
      const entry = dayMap.get(row.day);
      entry.botCount += 1;
      if (row.uptime_pct !== null && row.uptime_pct !== undefined) {
        entry.uptimeSum += row.uptime_pct;
        entry.uptimeCount += 1;
        if (row.uptime_pct < 95) entry.problemCount += 1;
      }
    });
  });

  const days = Array.from(dayMap.keys()).sort();
  return {
    totalSeries: days.map((d) => dayMap.get(d).botCount),
    healthySeries: days.map((d) => {
      const e = dayMap.get(d);
      return e.uptimeCount > 0 ? e.uptimeSum / e.uptimeCount : null;
    }),
    problemSeries: days.map((d) => dayMap.get(d).problemCount),
  };
}

function renderSparkline(canvasId, values, colorHex) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.closest('.summary-sparkline-wrap');

  const validPoints = values.filter((v) => v !== null && v !== undefined);
  if (sparklineCharts[canvasId]) {
    sparklineCharts[canvasId].destroy();
    delete sparklineCharts[canvasId];
  }

  // bot ใหม่ยังไม่มี daily หรือมีข้อมูลไม่พอทำเส้น (<2 จุด) → ซ่อน canvas ทั้งอัน ไม่แสดงเส้นว่าง/เส้นแบน
  if (validPoints.length < 2 || !window.Chart) {
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (wrap) wrap.style.display = '';

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 32);
  gradient.addColorStop(0, hexToRgba(colorHex, 0.18));
  gradient.addColorStop(1, hexToRgba(colorHex, 0));

  sparklineCharts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: values.map((_, i) => i),
      datasets: [{
        data: values,
        borderColor: colorHex,
        backgroundColor: gradient,
        borderWidth: 1.5,
        tension: 0.35,
        fill: true,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { x: { display: false }, y: { display: false } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      elements: { point: { radius: 0 } },
    },
  });
}

function updateActiveCardUI() {
  document.querySelectorAll('.summary-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.filter !== '' && card.dataset.filter === activeCardFilter);
  });
}

function relativeTimeText(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return 'เมื่อสักครู่';
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const min = Math.floor(sec / 60);
  return `${min} นาทีที่แล้ว`;
}

function updateRefreshNote() {
  if (!lastRefreshedAt) return;
  refreshNote.textContent = `อัปเดตเมื่อ ${relativeTimeText(lastRefreshedAt)}`;
}
