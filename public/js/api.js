async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('unauthorized');
  }
  let data = null;
  try { data = await res.json(); } catch (err) { /* no body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `request failed: ${res.status}`);
  }
  return data;
}

function apiListBots() {
  return fetchJson('/api/bots');
}

function apiGetBotHealth(id) {
  return fetchJson(`/api/bots/${id}/health`);
}

function apiGetStatsSummary(name) {
  return fetchJson(`/api/bots/${name}/stats/summary`);
}

function apiGetStatsDaily(name, days) {
  return fetchJson(`/api/bots/${name}/stats/daily?days=${days}`);
}

function apiGetStatsSamples(name, hours) {
  return fetchJson(`/api/bots/${name}/stats/samples?hours=${hours}`);
}

function apiCreateBot(payload) {
  return fetchJson('/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function apiBotAction(id, action) {
  return fetchJson(`/api/bots/${id}/${action}`, { method: 'POST' });
}

function apiRemoveBot(id, deleteFiles) {
  return fetchJson(`/api/bots/${id}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
}

function apiGetBotLogs(id) {
  return fetchJson(`/api/bots/${id}/logs`);
}

function apiGetTunnelLogs(name) {
  return fetchJson(`/api/bots/${name}/tunnel/logs`);
}

function apiAttachTunnel(name, token) {
  return fetchJson(`/api/bots/${name}/tunnel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

function apiDetachTunnel(name) {
  return fetchJson(`/api/bots/${name}/tunnel`, { method: 'DELETE' });
}

function apiGetMeta(name) {
  return fetchJson(`/api/bots/${name}/meta`);
}

function apiUpdateMeta(name, payload) {
  return fetchJson(`/api/bots/${name}/meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function apiGetBotConfig(name) {
  return fetchJson(`/api/bots/${name}/config`);
}

function apiSaveBotConfig(name, payload) {
  return fetchJson(`/api/bots/${name}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function apiPullImage() {
  return fetchJson('/api/image/pull', { method: 'POST' });
}

function apiLogout() {
  return fetch('/api/auth/logout', { method: 'POST' });
}

async function loadBots() {
  let bots;
  try {
    bots = await apiListBots();
  } catch (err) {
    return;
  }

  // ดึง health ของทุก bot ที่ running มาก่อน render — การ์ดสรุป + filter "มีปัญหา"
  // ต้องใช้ข้อมูลนี้ตั้งแต่รอบแรก ไม่ใช่ทยอยเติมทีหลังเหมือนเดิม
  await Promise.all(bots.filter((b) => b.state === 'running').map(async (bot) => {
    try {
      bot.health = await apiGetBotHealth(bot.id);
    } catch (err) {
      bot.health = { ok: false, reason: 'error' };
    }
  }));

  botsCache = bots;
  lastRefreshedAt = Date.now();
  updateRefreshNote();
  renderSummaryBar(bots);
  renderTable();

  // sparkline ใช้ daily stats ซึ่งเปลี่ยนไม่บ่อย — ไม่ต้อง await ให้บล็อก render หลัก
  // ตัว refreshSparklineData เองมี cache กันไม่ให้ query ซ้ำถี่กว่า 5 นาที
  refreshSparklineData(bots);
}

async function loadBotUptime(bot, animate) {
  const name = botDisplayName(bot);
  const cell = tbody.querySelector(`tr[data-id="${bot.id}"] .uptime-cell`);
  if (!cell) return;
  try {
    const summary = await apiGetStatsSummary(name);
    cell.innerHTML = uptimeCell(summary.last30d, animate);
  } catch (err) {
    cell.innerHTML = uptimeCell(null, animate);
  }
  if (animate) animateUptimeBar(cell);
}

// รัน async fn บน items ทีละไม่เกิน `limit` ตัวพร้อมกัน (ไม่ต้องพึ่ง library)
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

const SPARKLINE_COLORS = { total: '#00d4a0', healthy: '#2ecc8f', problem: '#ff5c5c' };
const SPARKLINE_REFRESH_MS = 5 * 60 * 1000;

async function refreshSparklineData(bots, force) {
  const now = Date.now();
  if (!force && now - sparklineCacheAt < SPARKLINE_REFRESH_MS) return;
  sparklineCacheAt = now;

  if (!bots.length) {
    renderSparkline('sparkTotal', [], SPARKLINE_COLORS.total);
    renderSparkline('sparkHealthy', [], SPARKLINE_COLORS.healthy);
    renderSparkline('sparkProblem', [], SPARKLINE_COLORS.problem);
    return;
  }

  const names = bots.map(botDisplayName);
  const dailyResults = await mapWithConcurrency(names, 5, async (name) => {
    try {
      return { name, rows: await apiGetStatsDaily(name, 7) };
    } catch (err) {
      return { name, rows: [] };
    }
  });

  const series = buildSparklineSeries(dailyResults);
  renderSparkline('sparkTotal', series.totalSeries, SPARKLINE_COLORS.total);
  renderSparkline('sparkHealthy', series.healthySeries, SPARKLINE_COLORS.healthy);
  renderSparkline('sparkProblem', series.problemSeries, SPARKLINE_COLORS.problem);
}
