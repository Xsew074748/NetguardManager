// stats modal แบบแท็บ: ภาพรวม (เดิม) / Zabbix / Omada / HikCentral — ใช้ Chart.js ตัวเดิมที่โหลดใน index.html
// ข้อมูลมาจาก GET /api/bots/:name/stats/series?range=24h|7d|30d (SQLite ของ manager)
// แท็บของระบบที่ bot ไม่ได้เปิดใช้ (available:false) จะไม่แสดง — ไม่ผูกกับชื่อ bot ใด ๆ

const statsView = { name: null, tab: 'overview', range: '24h', overview: null, series: null, seriesError: null };
let statsCharts = [];

const STATS_TABS = [
  { key: 'overview', label: 'ภาพรวม' },
  { key: 'zabbix', label: 'Zabbix' },
  { key: 'omada', label: 'Omada' },
  { key: 'hikcentral', label: 'HikCentral' },
];
const STATS_RANGES = [{ key: '24h', label: '24 ชม.' }, { key: '7d', label: '7 วัน' }, { key: '30d', label: '30 วัน' }];

const C = {
  teal: '#00d4a0', purple: '#7c6cf6', amber: '#f5a623', red: '#ff5c5c', green: '#2ecc8f',
  orange: '#ff8a3d', blue: '#4da3ff', yellow: '#e6c84a', grey: '#8b96a8',
};
const AXIS = { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#8b96a8' } };

// ── ตัวช่วยจัดรูปแบบ ──────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  let v = Number(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('th-TH', { maximumFractionDigits: digits });
}

// bytes ในช่วง windowSec → Mbps (หน่วยของ bucket จาก Omada ยังไม่ยืนยัน — สมมติเป็น bytes)
function mbps(bytes, windowSec) {
  if (bytes === null || bytes === undefined || !(windowSec > 0)) return null;
  return Math.round((bytes * 8 / windowSec / 1e6) * 100) / 100;
}

function sum(points, key) {
  let total = 0; let seen = false;
  for (const p of points) if (p[key] !== null && p[key] !== undefined) { total += Number(p[key]); seen = true; }
  return seen ? total : null;
}

function lastWith(points, key) {
  for (let i = points.length - 1; i >= 0; i--) if (points[i][key] !== null && points[i][key] !== undefined) return points[i];
  return null;
}

function tickLabel(t, range) {
  const d = new Date(t * 1000);
  if (range === '24h') return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (range === '7d') return d.toLocaleString('th-TH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit' });
}

function destroyStatsCharts() {
  statsCharts.forEach((c) => c.destroy());
  statsCharts = [];
  if (typeof uptimeChart !== 'undefined' && uptimeChart) { uptimeChart.destroy(); uptimeChart = null; }
  if (typeof problemsChart !== 'undefined' && problemsChart) { problemsChart.destroy(); problemsChart = null; }
}

// ── ส่วนประกอบ HTML ───────────────────────────────────────────────────────────────
function statCard(label, value, sub) {
  return `<div class="stat-big-card"><div class="stat-big-label">${escapeHtml(label)}</div>`
    + `<div class="stat-big-number stat-card-value">${value}</div>`
    + (sub ? `<div class="stat-big-sub">${sub}</div>` : '') + '</div>';
}

function chartBlock(id, title, hasData, tall = false) {
  return `<div class="stat-chart-section"><div class="stat-chart-title">${escapeHtml(title)}</div>`
    + (hasData
      ? `<div class="stat-chart-wrap${tall ? ' tall' : ''}"><canvas id="${id}"></canvas></div>`
      : '<div class="stats-empty">ยังไม่มีข้อมูลในช่วงนี้</div>')
    + '</div>';
}

function banner(text) {
  return `<div class="stats-banner">${text}</div>`;
}

function addChart(id, config) {
  const el = document.getElementById(id);
  if (el && window.Chart) statsCharts.push(new Chart(el, config));
}

function baseOptions({ stacked = false, yTitle, beginAtZero = true, legend = true, horizontal = false, yMax, integer = false } = {}) {
  const valueAxis = { ...AXIS, ticks: { ...AXIS.ticks, ...(integer ? { precision: 0 } : {}) }, stacked, beginAtZero, ...(yMax ? { max: yMax } : {}), title: yTitle ? { display: true, text: yTitle, color: '#8b96a8' } : undefined };
  const labelAxis = { ...AXIS, stacked, ticks: { ...AXIS.ticks, maxTicksLimit: 8, maxRotation: 0 } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    ...(horizontal ? { indexAxis: 'y' } : {}),
    interaction: { mode: 'index', intersect: false },
    scales: horizontal ? { x: valueAxis, y: { ...AXIS, stacked, ticks: { ...AXIS.ticks, autoSkip: false } } } : { x: labelAxis, y: valueAxis },
    plugins: { legend: { display: legend, labels: { color: '#8b96a8', boxWidth: 12 } } },
  };
}

function ds(label, data, color, extra = {}) {
  return { label, data, borderColor: color, backgroundColor: color + '33', tension: 0.25, spanGaps: true, pointRadius: 0, borderWidth: 2, ...extra };
}

function labelsOf(points, range) {
  return points.map((p) => tickLabel(p.t, range));
}

const hasAny = (points, keys) => points.some((p) => keys.some((k) => p[k] !== null && p[k] !== undefined));

// ── แท็บ Zabbix ──────────────────────────────────────────────────────────────────
function renderZabbixTab(series, range) {
  const pts = series.zabbix.points;
  const lbl = labelsOf(pts, range);
  const latest = (series.latest && series.latest.base) || null; // ค่าล่าสุดจริง ไม่ใช่เฉลี่ยของ bucket ท้ายสุด
  const lastP = latest && latest.problems_total != null ? latest : lastWith(pts, 'problems_total');
  const lastH = latest && latest.hosts_total != null ? latest : lastWith(pts, 'hosts_total');
  const lastC = latest && latest.cameras_total != null ? latest : lastWith(pts, 'cameras_total');
  const maxP = pts.reduce((m, p) => (p.problems_total !== null && p.problems_total > m ? p.problems_total : m), 0);
  const down = (p, t, u) => (p ? Math.max(0, Math.round(p[t] - p[u])) : null);

  const html = `
    <div class="stat-card-grid">
      ${statCard('Problems ตอนนี้', lastP ? fmtNum(lastP.problems_total) : '—', lastP ? `สูงสุดในช่วง ${fmtNum(maxP)}` : '')}
      ${statCard('Host ที่ down', lastH ? fmtNum(down(lastH, 'hosts_total', 'hosts_up')) : '—', lastH ? `จาก ${fmtNum(lastH.hosts_total)} เครื่อง` : '')}
      ${statCard('กล้องที่ down', lastC ? fmtNum(down(lastC, 'cameras_total', 'cameras_up')) : '—', lastC ? `จาก ${fmtNum(lastC.cameras_total)} ตัว` : '')}
    </div>
    ${chartBlock('zbxProblems', 'Problems แยกตามความรุนแรง', hasAny(pts, ['problems_total']))}
    ${chartBlock('zbxHosts', 'Host (Zabbix) — Up / Down', hasAny(pts, ['hosts_total']))}
    ${chartBlock('zbxCams', 'กล้อง — Up / Down', hasAny(pts, ['cameras_total']))}
    ${range !== '24h' ? '<div class="stat-chart-note">ช่วง 7/30 วัน แสดงค่าเฉลี่ยต่อ bucket</div>' : ''}`;

  const draw = () => {
    addChart('zbxProblems', {
      type: 'line',
      data: {
        labels: lbl,
        datasets: [
          ds('Disaster', pts.map((p) => p.problems_disaster), C.red, { fill: true, stack: 's' }),
          ds('High', pts.map((p) => p.problems_high), C.orange, { fill: true, stack: 's' }),
          ds('Average', pts.map((p) => p.problems_average), C.amber, { fill: true, stack: 's' }),
          ds('Warning', pts.map((p) => p.problems_warning), C.yellow, { fill: true, stack: 's' }),
        ],
      },
      options: baseOptions({ stacked: true }),
    });
    const upDown = (id, total, up) => addChart(id, {
      type: 'line',
      data: {
        labels: lbl,
        datasets: [
          ds('Up', pts.map((p) => (p[up] ?? null)), C.teal),
          ds('Down', pts.map((p) => (p[total] !== null && p[total] !== undefined && p[up] !== null ? Math.max(0, p[total] - p[up]) : null)), C.red),
        ],
      },
      options: baseOptions({ integer: range === '24h' }),
    });
    upDown('zbxHosts', 'hosts_total', 'hosts_up');
    upDown('zbxCams', 'cameras_total', 'cameras_up');
  };
  return { html, draw };
}

// ── แท็บ Omada ───────────────────────────────────────────────────────────────────
function renderOmadaTab(series, range) {
  const o = series.omada;
  const pts = o.points;
  const base = series.zabbix.points; // aps/switches up จาก samples เดิม
  const lbl = labelsOf(pts, range);
  const lastO = series.latest && series.latest.omada;
  const last = lastO || lastWith(pts, 'clients');
  const lastBase = (series.latest && series.latest.base) || lastWith(base, 'aps_total');
  const rx = sum(pts, 'ap_rx'); const tx = sum(pts, 'ap_tx');
  const top = o.topClients[0];
  const apDown = lastBase ? Math.max(0, Math.round(lastBase.aps_total - lastBase.aps_up)) : null;
  const swDown = lastBase ? Math.max(0, Math.round(lastBase.switches_total - lastBase.switches_up)) : null;
  const power = lastO && lastO.power != null ? lastO : lastWith(pts, 'power');
  const trafficPts = pts.filter((p) => p.window_sec > 0 && (p.ap_rx !== null || p.ap_tx !== null));
  const st = series.detail && series.detail.status;

  let notice = '';
  if (st === 'unsupported') notice = banner('bot นี้ยังใช้ image เก่าที่ไม่มีข้อมูลละเอียด (/stats/detail) — ต้องอัปเดต image แล้ว "ลบแล้วสร้างใหม่" bot');
  else if (st === 'error') notice = banner('ดึงข้อมูลละเอียดจาก bot ล่าสุดไม่สำเร็จ — กราฟอาจไม่เป็นปัจจุบัน');
  else if (st === 'partial' && series.detail.failed && series.detail.failed.includes('omada')) notice = banner('ข้อมูล Omada บางส่วนดึงไม่ได้ในรอบล่าสุด');

  const html = `${notice}
    <div class="stat-card-grid">
      ${statCard('Client ตอนนี้', last ? fmtNum(last.clients) : '—', last ? `ไร้สาย ${fmtNum(last.wireless)} · มีสาย ${fmtNum(last.wired)}` : '')}
      ${statCard('Traffic ในช่วงนี้ (AP)', rx === null && tx === null ? '—' : `↓ ${fmtBytes(rx)}`, rx === null && tx === null ? '' : `↑ ${fmtBytes(tx)}`)}
      ${statCard('Client ใช้มากสุด', top ? escapeHtml(top.name || top.mac || '—') : '—', top ? `${fmtBytes(top.total)} (ประมาณ)` : 'ยังไม่มีข้อมูล')}
      ${statCard('AP / Switch ที่ down', lastBase ? `${fmtNum(apDown)} / ${fmtNum(swDown)}` : '—', lastBase ? `จาก ${fmtNum(lastBase.aps_total)} AP · ${fmtNum(lastBase.switches_total)} Switch` : '')}
      ${power && power.power > 0 ? statCard('PoE ใช้ไฟ', `${fmtNum(power.power, 1)} W`, '') : ''}
    </div>
    ${chartBlock('omClients', 'จำนวน Client', hasAny(pts, ['clients']))}
    ${chartBlock('omBands', 'Client ไร้สายแยกตามคลื่น', hasAny(pts, ['c2g', 'c5g', 'c6g']))}
    ${chartBlock('omTraffic', 'Throughput ของ AP (Mbps)', trafficPts.length > 0)}
    ${chartBlock('omTop', 'Top 10 Client ที่ใช้ traffic มากสุด (MB)', o.topClients.length > 0, true)}
    ${chartBlock('omDown', 'AP / Switch ที่ down', hasAny(base, ['aps_total', 'switches_total']))}
    <div class="stat-chart-note">Top client เป็นค่าประมาณจากผลต่างของยอดสะสมต่อ client (เก็บ 10 อันดับต่อรอบ) ·
    traffic/คลื่น/Top client ที่เป็น "—" แปลว่า controller ไม่ส่งค่ามาหรือยังไม่มีการใช้งาน</div>`;

  const draw = () => {
    addChart('omClients', {
      type: 'line',
      data: { labels: lbl, datasets: [
        ds('ทั้งหมด', pts.map((p) => p.clients), C.teal, { fill: true }),
        ds('ไร้สาย', pts.map((p) => p.wireless), C.purple),
        ds('มีสาย', pts.map((p) => p.wired), C.blue),
      ] },
      options: baseOptions(),
    });
    addChart('omBands', {
      type: 'line',
      data: { labels: lbl, datasets: [
        ds('2.4 GHz', pts.map((p) => p.c2g), C.amber, { fill: true, stack: 'b' }),
        ds('5 GHz', pts.map((p) => p.c5g), C.teal, { fill: true, stack: 'b' }),
        ds('6 GHz', pts.map((p) => p.c6g), C.purple, { fill: true, stack: 'b' }),
      ] },
      options: baseOptions({ stacked: true }),
    });
    addChart('omTraffic', {
      type: 'line',
      data: { labels: labelsOf(trafficPts, range), datasets: [
        ds('Download', trafficPts.map((p) => mbps(p.ap_rx, p.window_sec)), C.teal, { fill: true }),
        ds('Upload', trafficPts.map((p) => mbps(p.ap_tx, p.window_sec)), C.purple),
      ] },
      options: baseOptions({ yTitle: 'Mbps' }),
    });
    const MB = 1024 * 1024;
    addChart('omTop', {
      type: 'bar',
      data: { labels: o.topClients.map((c) => c.name || c.mac || '?'), datasets: [
        { label: 'Download', data: o.topClients.map((c) => Math.round((c.down / MB) * 10) / 10), backgroundColor: C.teal },
        { label: 'Upload', data: o.topClients.map((c) => Math.round((c.up / MB) * 10) / 10), backgroundColor: C.purple },
      ] },
      options: baseOptions({ stacked: true, horizontal: true }),
    });
    addChart('omDown', {
      type: 'line',
      data: { labels: labelsOf(base, range), datasets: [
        ds('AP down', base.map((p) => (p.aps_total != null && p.aps_up != null ? Math.max(0, p.aps_total - p.aps_up) : null)), C.red),
        ds('Switch down', base.map((p) => (p.switches_total != null && p.switches_up != null ? Math.max(0, p.switches_total - p.switches_up) : null)), C.orange),
      ] },
      options: baseOptions({ integer: range === '24h' }),
    });
  };
  return { html, draw };
}

// ── แท็บ HikCentral ──────────────────────────────────────────────────────────────
function renderHikTab(series, range) {
  const h = series.hikcentral;
  const pts = h.points;
  const base = series.zabbix.points;
  const lbl = labelsOf(pts, range);
  const total = sum(pts, 'total');
  const types = [
    ['Motion', sum(pts, 'motion'), C.teal], ['Video loss', sum(pts, 'video_loss'), C.red],
    ['Tamper', sum(pts, 'tamper'), C.orange], ['อื่น ๆ', sum(pts, 'other'), C.grey],
  ];
  const topType = types.filter((t) => t[1] > 0).sort((a, b) => b[1] - a[1])[0];
  const lastCam = (series.latest && series.latest.base) || lastWith(base, 'cameras_total');
  const topCam = h.topCameras[0];
  const st = series.detail && series.detail.status;

  let notice = '';
  if (st === 'unsupported') notice = banner('bot นี้ยังใช้ image เก่าที่ไม่มีข้อมูลละเอียด (/stats/detail) — ต้องอัปเดต image แล้ว "ลบแล้วสร้างใหม่" bot');
  else if (series.detail && series.detail.eventsUnavailable === 'event-types-not-configured') {
    notice = banner('ยังไม่ได้ตั้ง <code>HIKCENTRAL_EVENT_TYPES</code> (รหัสชนิด event คั่นด้วย ,) ใน .env ของ bot — จึงยังไม่เก็บ event ของ HikCentral');
  } else if (st === 'error') notice = banner('ดึงข้อมูลละเอียดจาก bot ล่าสุดไม่สำเร็จ — กราฟอาจไม่เป็นปัจจุบัน');
  else if (st === 'partial' && series.detail.failed && series.detail.failed.includes('hikcentral')) notice = banner('ดึง event จาก HikCentral ไม่สำเร็จในรอบล่าสุด (เช่น timeout) — จะดึงช่วงที่ขาดให้รอบถัดไป');

  const html = `${notice}
    <div class="stat-card-grid">
      ${statCard('Event ในช่วงนี้', fmtNum(total), total === null ? 'ยังไม่มีข้อมูล' : '')}
      ${statCard('กล้อง online / offline', lastCam ? `${fmtNum(lastCam.cameras_up)} / ${fmtNum(Math.max(0, lastCam.cameras_total - lastCam.cameras_up))}` : '—', lastCam ? `จาก ${fmtNum(lastCam.cameras_total)} ตัว (รวมทุกแหล่ง)` : '')}
      ${statCard('Event ที่พบบ่อยสุด', topType ? escapeHtml(topType[0]) : '—', topType ? `${fmtNum(topType[1])} ครั้ง` : '')}
      ${statCard('กล้องที่มี event มากสุด', topCam ? escapeHtml(topCam.name || topCam.id || '—') : '—', topCam ? `${fmtNum(topCam.count)} ครั้ง` : '')}
    </div>
    ${chartBlock('hkEvents', 'Event ตามช่วงเวลา แยกชนิด', pts.length > 0)}
    ${chartBlock('hkCams', 'กล้อง online / offline', hasAny(base, ['cameras_total']))}
    ${chartBlock('hkTop', 'Top 5 กล้องที่มี event มากสุด', h.topCameras.length > 0, true)}
    <div class="stat-chart-note">การแยกชนิด event อาศัยชื่อ event · Top กล้องนับจาก 5 อันดับต่อรอบ จึงเป็นค่าประมาณ</div>`;

  const draw = () => {
    addChart('hkEvents', {
      type: 'bar',
      data: { labels: lbl, datasets: [
        { label: 'Motion', data: pts.map((p) => p.motion), backgroundColor: C.teal },
        { label: 'Video loss', data: pts.map((p) => p.video_loss), backgroundColor: C.red },
        { label: 'Tamper', data: pts.map((p) => p.tamper), backgroundColor: C.orange },
        { label: 'อื่น ๆ', data: pts.map((p) => p.other), backgroundColor: C.grey },
      ] },
      options: baseOptions({ stacked: true }),
    });
    addChart('hkCams', {
      type: 'line',
      data: { labels: labelsOf(base, range), datasets: [
        ds('Online', base.map((p) => p.cameras_up ?? null), C.teal),
        ds('Offline', base.map((p) => (p.cameras_total != null && p.cameras_up != null ? Math.max(0, p.cameras_total - p.cameras_up) : null)), C.red),
      ] },
      options: baseOptions({ integer: range === '24h' }),
    });
    addChart('hkTop', {
      type: 'bar',
      data: { labels: h.topCameras.map((c) => c.name || c.id || '?'), datasets: [{ label: 'Event', data: h.topCameras.map((c) => c.count), backgroundColor: C.purple }] },
      options: baseOptions({ horizontal: true, legend: false }),
    });
  };
  return { html, draw };
}

// ── เปลือกของ modal: แท็บ + ตัวเลือกช่วงเวลา + panel ───────────────────────────────
function availableStatsTabs() {
  const s = statsView.series;
  return STATS_TABS.filter((t) => t.key === 'overview' || (s && s[t.key] && s[t.key].available));
}

function renderStatsShell() {
  const tabs = availableStatsTabs();
  if (!tabs.some((t) => t.key === statsView.tab)) statsView.tab = 'overview';
  const tabBar = tabs.length > 1
    ? `<div class="stats-tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" class="stats-tab${t.key === statsView.tab ? ' active' : ''}" data-stats-tab="${t.key}">${t.label}</button>`).join('')}</div>`
    : '';
  const rangeBar = statsView.tab === 'overview' ? ''
    : `<div class="stats-range">${STATS_RANGES.map((r) => `<button type="button" class="stats-range-btn${r.key === statsView.range ? ' active' : ''}" data-stats-range="${r.key}">${r.label}</button>`).join('')}</div>`;
  statsModalBody.innerHTML = `${tabBar}${rangeBar}<div id="statsTabPanel"></div>`;
  statsModalBody.querySelectorAll('[data-stats-tab]').forEach((b) => b.addEventListener('click', () => {
    statsView.tab = b.dataset.statsTab;
    renderStatsShell();
  }));
  statsModalBody.querySelectorAll('[data-stats-range]').forEach((b) => b.addEventListener('click', () => changeStatsRange(b.dataset.statsRange)));
  renderStatsPanel();
}

function renderStatsPanel() {
  destroyStatsCharts();
  const panel = document.getElementById('statsTabPanel');
  if (!panel) return;
  if (statsView.tab === 'overview') {
    panel.innerHTML = overviewHtml(statsView.overview.summary, statsView.overview.samples);
    drawOverviewCharts(statsView.overview.daily, statsView.overview.samples);
    return;
  }
  if (!statsView.series) {
    panel.innerHTML = `<div class="form-error show">โหลดข้อมูลกราฟไม่สำเร็จ: ${escapeHtml(statsView.seriesError || 'ไม่ทราบสาเหตุ')}</div>`;
    return;
  }
  const renderers = { zabbix: renderZabbixTab, omada: renderOmadaTab, hikcentral: renderHikTab };
  const out = renderers[statsView.tab](statsView.series, statsView.range);
  panel.innerHTML = out.html;
  out.draw();
}

async function changeStatsRange(range) {
  if (range === statsView.range) return;
  statsView.range = range;
  const panel = document.getElementById('statsTabPanel');
  if (panel) panel.innerHTML = 'Loading...';
  try {
    statsView.series = await apiGetStatsSeries(statsView.name, range);
    statsView.seriesError = null;
  } catch (err) {
    statsView.series = null;
    statsView.seriesError = err.message;
  }
  renderStatsShell();
}
