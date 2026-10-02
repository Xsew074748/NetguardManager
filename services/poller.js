const dockerService = require('./docker');
const statsDb = require('./stats-db');
const logger = require('./logger');
const config = require('../config');

const POLL_INTERVAL_MS      = 5 * 60 * 1000;
const STATS_FETCH_TIMEOUT_MS = 10 * 1000;
// /stats/detail ของ bot ยิง Omada/HikCentral จริง (HikCentral เคย timeout 10 วิ) → timeout ยาวกว่า /stats
const DETAIL_FETCH_TIMEOUT_MS = 20 * 1000;
const HOURLY_CHECK_MS        = 60 * 60 * 1000;

let pollTimer = null;
let hourlyTimer = null;
let lastRollupDay = null;

function stripPrefix(containerName) {
  return containerName.replace(/^netguard-/, '');
}

// POLLER_BOTS (config.pollerBots) ว่าง = poll ทุก bot; มีค่า = poll เฉพาะ bot ในรายการ
// ใช้ตอนรัน Manager ชั่วคราวเพื่อทดสอบ ไม่ให้ไปยิง bot production
function isPolled(bot) {
  const only = config.pollerBots;
  return !only || only.length === 0 || only.includes(stripPrefix(bot.name));
}

// ── ข้อมูลละเอียด (GET /stats/detail ของ bot) ─────────────────────────────────────
// สถานะต่อ bot เก็บในหน่วยความจำ: ต้นหน้าต่างของ traffic (Omada) กับ event (HikCentral) แยกกัน
// เลื่อนเฉพาะเมื่อฝั่งนั้นถูกเขียนลง DB สำเร็จ → ฝั่งหนึ่งพังรอบหนึ่งก็ไม่นับซ้ำ/ไม่ทิ้งช่วงของอีกฝั่ง
const detailState = new Map();

function getDetailState(botName) {
  let st = detailState.get(botName);
  if (!st) {
    let last = { omadaTraffic: null, hikEvents: null };
    try { last = statsDb.getLastDetailTs(botName); } catch { /* DB ยังไม่พร้อม — เริ่มจากหน้าต่างปริยายของ bot */ }
    st = { omadaSince: last.omadaTraffic, hikSince: last.hikEvents, status: 'unknown', monitors: [], failed: [], eventsUnavailable: null, checkedAt: null };
    detailState.set(botName, st);
  }
  return st;
}

// สถานะล่าสุดของการดึงข้อมูลละเอียด (ให้ API/หน้า stats ใช้บอกว่า bot รองรับไหม และ monitor อะไรเปิดอยู่)
function getDetailStatus(botName) {
  const st = detailState.get(botName);
  return st ? { status: st.status, monitors: st.monitors, failed: st.failed, eventsUnavailable: st.eventsUnavailable, checkedAt: st.checkedAt } : null;
}

async function fetchBotDetail(botName, since, eventsSince) {
  const qs = new URLSearchParams();
  if (since) qs.set('since', String(since));
  if (eventsSince) qs.set('eventsSince', String(eventsSince));
  const res = await fetch(`http://netguard-${botName}:3000/stats/detail?${qs}`, {
    signal: AbortSignal.timeout(DETAIL_FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) {
    const err = new Error('bot ยังใช้ image เก่า (ไม่มี /stats/detail)');
    err.code = 'unsupported';
    throw err;
  }
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

// ต้องไม่ throw และไม่กระทบสถานะ up/down ของ bot — ล้มเหลว = ข้ามรอบนี้ log ไว้ ส่วนอื่นยังเก็บต่อ
async function pollDetail(botName, stats, { fetchDetail = fetchBotDetail, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const st = getDetailState(botName);
  const monitors = Array.isArray(stats && stats.monitors) ? stats.monitors : [];
  st.monitors = monitors;
  if (!monitors.includes('omada') && !monitors.includes('hikcentral')) {
    st.status = 'not-applicable';
    return null;
  }

  const prevStatus = st.status;
  try {
    const data = await fetchDetail(botName, st.omadaSince, st.hikSince);
    if (!data || data.ok !== true) throw new Error('detail response ไม่ ok');
    const ts = now();
    const written = statsDb.insertDetail(botName, data, ts);
    if (written.omadaTraffic) st.omadaSince = ts;
    if (written.hik) st.hikSince = ts;
    st.status = data.partial ? 'partial' : 'ok';
    st.failed = Array.isArray(data.failed) ? data.failed : [];
    st.eventsUnavailable = (data.hikcentral && data.hikcentral.eventsUnavailable) || null;
    st.checkedAt = ts;
    if (data.partial) logger.warn(`poller: detail ของ "${botName}" ได้ไม่ครบ (ล้มเหลว: ${st.failed.join(', ')})`);
    return written;
  } catch (err) {
    st.status = err.code === 'unsupported' ? 'unsupported' : 'error';
    st.checkedAt = now();
    // bot image เก่าจะ 404 ทุกรอบ — log ครั้งเดียวตอนสถานะเปลี่ยน ไม่ท่วม log ทุก 5 นาที
    if (st.status === 'error' || prevStatus !== 'unsupported') {
      logger.warn(`poller: ดึง /stats/detail ของ "${botName}" ไม่สำเร็จ: ${err.message}`);
    }
    return null;
  }
}

// bot คุยกับ bot ผ่าน Docker DNS (container name) เหมือน getBotHealth ใน services/docker.js
async function fetchBotStats(botName) {
  const res = await fetch(`http://netguard-${botName}:3000/stats`, {
    signal: AbortSignal.timeout(STATS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

async function pollOneBot(bot) {
  const botName = stripPrefix(bot.name);

  if (bot.state !== 'running') {
    statsDb.insertSample(botName, { state: 'down' });
    return;
  }

  let stats;
  try {
    stats = await fetchBotStats(botName);
    if (!stats || stats.ok !== true) throw new Error('stats response ไม่ ok');
    statsDb.insertSample(botName, {
      state: 'up',
      partial: !!stats.partial,
      problems: stats.problems || {},
      devices: stats.devices || {},
    });
  } catch (err) {
    logger.warn(`poller: ดึง /stats ของ "${botName}" ไม่สำเร็จ: ${err.message}`);
    statsDb.insertSample(botName, { state: 'down' });
    return;
  }
  // ข้อมูลละเอียดแยก try/catch ของตัวเอง — พังแล้ว uptime ของ bot ยังถูกต้อง
  await pollDetail(botName, stats).catch((err) => logger.warn(`poller: detail "${botName}": ${err.message}`));
}

async function pollAll() {
  let bots;
  try {
    bots = await dockerService.listBots();
  } catch (err) {
    logger.error('poller: listBots ล้มเหลว', err.message);
    return;
  }
  // poll ทุก bot พร้อมกัน — ไม่ให้ bot ที่ช้าบล็อกตัวอื่น
  await Promise.allSettled(bots.filter(isPolled).map(pollOneBot));
}

async function fillGapsForAllBots() {
  let bots;
  try {
    bots = await dockerService.listBots();
  } catch (err) {
    logger.warn('poller: fillGapsForAllBots — listBots ล้มเหลว', err.message);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  for (const bot of bots.filter(isPolled)) {
    const botName = stripPrefix(bot.name);
    const lastTs = statsDb.getLastSampleTs(botName);
    statsDb.fillUnknownGaps(botName, lastTs, now);
  }
}

function checkDailyRollup() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastRollupDay === today) return;

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  try {
    statsDb.rollupDaily(yesterday);
    statsDb.pruneOldSamples();
    statsDb.pruneDetail();
    statsDb.pruneAudit();
    lastRollupDay = today;
  } catch (err) {
    logger.error('poller: daily rollup ล้มเหลว', err.message);
  }
}

async function startPolling() {
  await fillGapsForAllBots();
  checkDailyRollup(); // เผื่อ manager restart ข้ามเที่ยงคืนไปโดยไม่ได้ rollup

  pollAll(); // รันทันทีตอน start ไม่ต้องรอครบ 5 นาที
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  hourlyTimer = setInterval(checkDailyRollup, HOURLY_CHECK_MS);
  logger.info('poller: started (interval=5min)');
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (hourlyTimer) { clearInterval(hourlyTimer); hourlyTimer = null; }
}

module.exports = { startPolling, stopPolling, pollAll, pollDetail, getDetailStatus };
