const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('./logger');

const POLL_INTERVAL_SEC = 5 * 60;
const MAX_GAP_FILL_ROWS = 288; // 1 วัน (288 * 5 นาที = 24 ชม.) กันกรณี manager ดับนานมาก
const RETENTION_DAYS = 60;
// ข้อมูลละเอียดจาก /stats/detail ของ bot (Omada/HikCentral): ดิบทุก 5 นาที เก็บสั้น, สรุปรายชั่วโมงเก็บนานกว่า
const DETAIL_RAW_RETENTION_DAYS = 14;
const DETAIL_HOURLY_RETENTION_DAYS = 90;

let db = null;

function initDb() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_name    TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      state       TEXT NOT NULL,
      partial     INTEGER DEFAULT 0,
      problems_total    INTEGER,
      problems_disaster INTEGER,
      problems_high     INTEGER,
      problems_average  INTEGER,
      problems_warning  INTEGER,
      hosts_total    INTEGER, hosts_up    INTEGER,
      aps_total      INTEGER, aps_up      INTEGER,
      switches_total INTEGER, switches_up INTEGER,
      cameras_total  INTEGER, cameras_up  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_samples_bot_ts ON samples(bot_name, ts);

    CREATE TABLE IF NOT EXISTS omada_samples (
      bot_name TEXT NOT NULL, ts INTEGER NOT NULL,
      window_sec INTEGER,           -- ช่วงเวลาที่ traffic ครอบคลุม (NULL = ดึง traffic ไม่ได้รอบนี้)
      clients_total INTEGER, clients_wireless INTEGER, clients_wired INTEGER,
      clients_2g INTEGER, clients_5g INTEGER, clients_6g INTEGER, clients_guest INTEGER,
      ap_tx REAL, ap_rx REAL, sw_tx REAL, sw_rx REAL,
      power_w REAL, ports_total INTEGER, ports_avail INTEGER,
      PRIMARY KEY (bot_name, ts)
    );
    -- top client ต่อ sample (ค่าสะสมตั้งแต่ client เชื่อมต่อ ไม่ใช่ต่อช่วง) — เก็บ 10 อันดับแรกเท่านั้นกัน DB บวม
    CREATE TABLE IF NOT EXISTS omada_top_clients (
      bot_name TEXT NOT NULL, ts INTEGER NOT NULL, rank INTEGER NOT NULL,
      mac TEXT, name TEXT, ap TEXT, down REAL, up REAL,
      PRIMARY KEY (bot_name, ts, rank)
    );
    CREATE TABLE IF NOT EXISTS omada_hourly (
      bot_name TEXT NOT NULL, hour_ts INTEGER NOT NULL, samples INTEGER,
      clients_avg REAL, clients_max INTEGER, wireless_avg REAL, wired_avg REAL,
      c2g_avg REAL, c5g_avg REAL, c6g_avg REAL, guest_avg REAL,
      ap_tx REAL, ap_rx REAL, sw_tx REAL, sw_rx REAL, power_avg REAL, covered_sec INTEGER,
      PRIMARY KEY (bot_name, hour_ts)
    );
    CREATE TABLE IF NOT EXISTS hik_samples (
      bot_name TEXT NOT NULL, ts INTEGER NOT NULL, window_sec INTEGER,
      ev_total INTEGER, ev_motion INTEGER, ev_video_loss INTEGER, ev_tamper INTEGER, ev_other INTEGER,
      truncated INTEGER DEFAULT 0,
      PRIMARY KEY (bot_name, ts)
    );
    CREATE TABLE IF NOT EXISTS hik_top_cameras (
      bot_name TEXT NOT NULL, ts INTEGER NOT NULL, rank INTEGER NOT NULL,
      cam_id TEXT, cam_name TEXT, cnt INTEGER,
      PRIMARY KEY (bot_name, ts, rank)
    );
    CREATE TABLE IF NOT EXISTS hik_hourly (
      bot_name TEXT NOT NULL, hour_ts INTEGER NOT NULL, samples INTEGER,
      ev_total INTEGER, ev_motion INTEGER, ev_video_loss INTEGER, ev_tamper INTEGER, ev_other INTEGER,
      covered_sec INTEGER,
      PRIMARY KEY (bot_name, hour_ts)
    );

    -- audit log การกระทำผ่าน Manager (ไม่เก็บ secret — ดู services/audit.js ที่กรองก่อนเขียนเสมอ)
    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,          -- วินาที (UTC)
      actor   TEXT,                      -- sess-xxxxxxxx (ตัวย่อของ session) หรือ anonymous
      ip      TEXT,
      action  TEXT NOT NULL,             -- เช่น bot.create, auth.login
      target  TEXT,                      -- ชื่อ bot / container id ย่อ
      result  TEXT NOT NULL,             -- ok | fail | denied | warn
      detail  TEXT                       -- JSON ที่ผ่าน sanitize แล้ว
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts);

    CREATE TABLE IF NOT EXISTS daily (
      bot_name     TEXT NOT NULL,
      day          TEXT NOT NULL,
      samples      INTEGER,
      up_count     INTEGER,
      down_count   INTEGER,
      unknown_count INTEGER,
      uptime_pct   REAL,
      avg_problems REAL,
      max_problems INTEGER,
      PRIMARY KEY (bot_name, day)
    );
  `);

  logger.info(`stats-db: initialized at ${config.dbPath}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('stats-db: not initialized — call initDb() first');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

let insertStatement = null;
function insertStmt() {
  if (!insertStatement) {
    insertStatement = getDb().prepare(`
      INSERT INTO samples (
        bot_name, ts, state, partial,
        problems_total, problems_disaster, problems_high, problems_average, problems_warning,
        hosts_total, hosts_up, aps_total, aps_up, switches_total, switches_up, cameras_total, cameras_up
      ) VALUES (
        @bot_name, @ts, @state, @partial,
        @problems_total, @problems_disaster, @problems_high, @problems_average, @problems_warning,
        @hosts_total, @hosts_up, @aps_total, @aps_up, @switches_total, @switches_up, @cameras_total, @cameras_up
      )
    `);
  }
  return insertStatement;
}

// data = { state, partial, problems, devices, ts } — ts เป็น optional (default = ตอนนี้)
// ใช้ตอนเติมช่องว่างย้อนหลังใน fillUnknownGaps()
function insertSample(botName, data = {}) {
  const { state, partial = false, problems = {}, devices = {}, ts = Math.floor(Date.now() / 1000) } = data;
  insertStmt().run({
    bot_name: botName,
    ts,
    state,
    partial: partial ? 1 : 0,
    problems_total:    problems.total    ?? null,
    problems_disaster: problems.disaster ?? null,
    problems_high:     problems.high     ?? null,
    problems_average:  problems.average  ?? null,
    problems_warning:  problems.warning  ?? null,
    hosts_total:    devices.hosts?.total    ?? null,
    hosts_up:       devices.hosts?.up       ?? null,
    aps_total:      devices.aps?.total      ?? null,
    aps_up:         devices.aps?.up         ?? null,
    switches_total: devices.switches?.total ?? null,
    switches_up:    devices.switches?.up    ?? null,
    cameras_total:  devices.cameras?.total  ?? null,
    cameras_up:     devices.cameras?.up     ?? null,
  });
}

function getSamples(botName, fromTs, toTs) {
  return getDb().prepare(`
    SELECT * FROM samples WHERE bot_name = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC
  `).all(botName, fromTs, toTs);
}

function getLastSampleTs(botName) {
  const row = getDb().prepare(`SELECT MAX(ts) AS ts FROM samples WHERE bot_name = ?`).get(botName);
  return row && row.ts != null ? row.ts : null;
}

function getDailyStats(botName, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDb().prepare(`
    SELECT * FROM daily WHERE bot_name = ? AND day >= ? ORDER BY day ASC
  `).all(botName, cutoff);
}

function computeUptimePct(up, down) {
  const denom = up + down;
  return denom > 0 ? Math.round((up / denom) * 1000) / 10 : null;
}

// สำคัญ: uptime คำนวณจาก up / (up + down) เท่านั้น — ไม่นับ unknown เป็น downtime
// เพราะ unknown แปลว่า manager เองไม่ได้ poll (restart/downtime ของ manager) ไม่ใช่ความผิดของ bot
function getUptimeSummary(botName) {
  const now = Math.floor(Date.now() / 1000);
  const samples24h = getSamples(botName, now - 24 * 3600, now);
  const up24h   = samples24h.filter((s) => s.state === 'up').length;
  const down24h = samples24h.filter((s) => s.state === 'down').length;

  const sumDaily = (rows) => rows.reduce(
    (acc, r) => ({ up: acc.up + (r.up_count || 0), down: acc.down + (r.down_count || 0) }),
    { up: 0, down: 0 }
  );
  const d7  = sumDaily(getDailyStats(botName, 7));
  const d30 = sumDaily(getDailyStats(botName, 30));

  return {
    last24h: computeUptimePct(up24h, down24h),
    last7d:  computeUptimePct(d7.up, d7.down),
    last30d: computeUptimePct(d30.up, d30.down),
  };
}

// สรุป samples ของวันที่กำหนด (YYYY-MM-DD, ขอบเขตวันแบบ UTC) ลง daily table — ใช้ INSERT OR REPLACE
function rollupDaily(day) {
  const dayStart = Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000);
  const dayEnd   = dayStart + 86400;

  const rows = getDb().prepare(`
    SELECT bot_name,
           COUNT(*) AS samples,
           SUM(CASE WHEN state = 'up' THEN 1 ELSE 0 END) AS up_count,
           SUM(CASE WHEN state = 'down' THEN 1 ELSE 0 END) AS down_count,
           SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
           AVG(problems_total) AS avg_problems,
           MAX(problems_total) AS max_problems
    FROM samples
    WHERE ts >= ? AND ts < ?
    GROUP BY bot_name
  `).all(dayStart, dayEnd);

  const upsert = getDb().prepare(`
    INSERT OR REPLACE INTO daily (bot_name, day, samples, up_count, down_count, unknown_count, uptime_pct, avg_problems, max_problems)
    VALUES (@bot_name, @day, @samples, @up_count, @down_count, @unknown_count, @uptime_pct, @avg_problems, @max_problems)
  `);

  const tx = getDb().transaction((items) => {
    for (const r of items) {
      upsert.run({
        bot_name: r.bot_name,
        day,
        samples: r.samples,
        up_count: r.up_count,
        down_count: r.down_count,
        unknown_count: r.unknown_count,
        uptime_pct: computeUptimePct(r.up_count, r.down_count),
        avg_problems: r.avg_problems,
        max_problems: r.max_problems,
      });
    }
  });
  tx(rows);

  logger.info(`stats-db: rollupDaily(${day}) — ${rows.length} bot(s)`);
  return rows.length;
}

// ลบ samples ที่เก่ากว่า RETENTION_DAYS วัน — daily table เก็บถาวรไม่ลบ
function pruneOldSamples() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  const info = getDb().prepare(`DELETE FROM samples WHERE ts < ?`).run(cutoff);
  logger.info(`stats-db: pruneOldSamples — removed ${info.changes} row(s) older than ${RETENTION_DAYS} days`);
  return info.changes;
}

// เติม sample state='unknown' ทุก POLL_INTERVAL_SEC ระหว่าง lastTs กับ nowTs
// เรียกตอน manager start เมื่อช่องว่างเกิน 2 รอบ poll (แปลว่า manager หยุดทำงานไปช่วงหนึ่ง)
// จำกัดไม่เกิน MAX_GAP_FILL_ROWS แถวต่อ bot กันกรณี manager ดับนานมาก
function fillUnknownGaps(botName, lastTs, nowTs) {
  if (lastTs == null) return 0; // ไม่มี sample เลย — bot ใหม่ ไม่ใช่ gap
  const gapSec = nowTs - lastTs;
  if (gapSec <= POLL_INTERVAL_SEC * 2) return 0;

  const stmt = insertStmt();
  const fill = getDb().transaction(() => {
    let ts = lastTs + POLL_INTERVAL_SEC;
    let count = 0;
    while (ts < nowTs && count < MAX_GAP_FILL_ROWS) {
      stmt.run({
        bot_name: botName, ts, state: 'unknown', partial: 0,
        problems_total: null, problems_disaster: null, problems_high: null, problems_average: null, problems_warning: null,
        hosts_total: null, hosts_up: null, aps_total: null, aps_up: null,
        switches_total: null, switches_up: null, cameras_total: null, cameras_up: null,
      });
      ts += POLL_INTERVAL_SEC;
      count++;
    }
    return count;
  });

  const inserted = fill();
  if (inserted > 0) {
    logger.info(`stats-db: fillUnknownGaps("${botName}") — inserted ${inserted} unknown sample(s)`);
  }
  return inserted;
}

// ── ข้อมูลละเอียด (Omada / HikCentral) ────────────────────────────────────────────

const intOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const numOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v, max = 120) => (v === null || v === undefined ? null : String(v).slice(0, max));

// detail = ผลจาก GET /stats/detail ของ bot — เก็บเฉพาะ section ที่ bot ดึงสำเร็จ (section ที่เป็น null ไม่ถูกเขียนเป็น 0)
// คืน { omada, omadaTraffic, hik } บอกว่าเขียน section ไหนลงไป (poller ใช้เลื่อนต้นหน้าต่างรอบถัดไป)
function insertDetail(botName, detail, ts = Math.floor(Date.now() / 1000)) {
  const out = { omada: false, omadaTraffic: false, hik: false };
  const d = getDb();
  const tx = d.transaction(() => {
    const o = detail && detail.omada;
    if (o && (o.clients || o.overview || o.traffic)) {
      const c = o.clients || {}; const ov = o.overview || {}; const t = o.traffic || null;
      // traffic ที่ field ชื่อไม่รู้จัก (tx/rx = null) ไม่นับว่าครอบคลุมช่วงเวลา
      const trafficOk = !!(t && t.apTx !== null && t.apTx !== undefined);
      d.prepare(`
        INSERT OR REPLACE INTO omada_samples (
          bot_name, ts, window_sec, clients_total, clients_wireless, clients_wired,
          clients_2g, clients_5g, clients_6g, clients_guest, ap_tx, ap_rx, sw_tx, sw_rx,
          power_w, ports_total, ports_avail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        botName, ts,
        trafficOk ? intOrNull(detail.windowSec) : null,
        intOrNull(c.total), intOrNull(c.wireless), intOrNull(c.wired),
        intOrNull(c.num2g), intOrNull(c.num5g), intOrNull(c.num6g), intOrNull(c.guest),
        t ? numOrNull(t.apTx) : null, t ? numOrNull(t.apRx) : null, t ? numOrNull(t.swTx) : null, t ? numOrNull(t.swRx) : null,
        numOrNull(ov.powerConsumption), intOrNull(ov.totalPorts), intOrNull(ov.availablePorts)
      );
      const ins = d.prepare(`INSERT OR REPLACE INTO omada_top_clients (bot_name, ts, rank, mac, name, ap, down, up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      (Array.isArray(o.topClients) ? o.topClients : []).slice(0, 10).forEach((cl, i) => {
        ins.run(botName, ts, i + 1, strOrNull(cl.mac, 40), strOrNull(cl.name), strOrNull(cl.ap), numOrNull(cl.down) || 0, numOrNull(cl.up) || 0);
      });
      out.omada = true;
      out.omadaTraffic = trafficOk;
    }

    const h = detail && detail.hikcentral;
    if (h && h.events) {
      const e = h.events;
      d.prepare(`
        INSERT OR REPLACE INTO hik_samples (bot_name, ts, window_sec, ev_total, ev_motion, ev_video_loss, ev_tamper, ev_other, truncated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(botName, ts, intOrNull(h.windowSec), intOrNull(e.total), intOrNull(e.motion), intOrNull(e.videoLoss),
        intOrNull(e.tamper), intOrNull(e.other), e.truncated ? 1 : 0);
      const ins = d.prepare(`INSERT OR REPLACE INTO hik_top_cameras (bot_name, ts, rank, cam_id, cam_name, cnt) VALUES (?, ?, ?, ?, ?, ?)`);
      (Array.isArray(h.topCameras) ? h.topCameras : []).slice(0, 5).forEach((cm, i) => {
        ins.run(botName, ts, i + 1, strOrNull(cm.id, 80), strOrNull(cm.name), intOrNull(cm.count) || 0);
      });
      out.hik = true;
    }
  });
  tx();
  if (out.omada || out.hik) rollupDetailHourly(ts - 2 * 3600);
  return out;
}

// สรุปรายชั่วโมงจาก sample ดิบ ตั้งแต่ชั่วโมงของ fromTs เป็นต้นไป — INSERT OR REPLACE จึงเรียกซ้ำได้ (ชั่วโมงปัจจุบันอัปเดตต่อเนื่อง)
function rollupDetailHourly(fromTs) {
  const from = Math.floor(fromTs / 3600) * 3600;
  getDb().prepare(`
    INSERT OR REPLACE INTO omada_hourly (
      bot_name, hour_ts, samples, clients_avg, clients_max, wireless_avg, wired_avg,
      c2g_avg, c5g_avg, c6g_avg, guest_avg, ap_tx, ap_rx, sw_tx, sw_rx, power_avg, covered_sec
    )
    SELECT bot_name, (ts / 3600) * 3600, COUNT(*), AVG(clients_total), MAX(clients_total), AVG(clients_wireless), AVG(clients_wired),
           AVG(clients_2g), AVG(clients_5g), AVG(clients_6g), AVG(clients_guest),
           SUM(ap_tx), SUM(ap_rx), SUM(sw_tx), SUM(sw_rx), AVG(power_w), SUM(window_sec)
    FROM omada_samples WHERE ts >= ? GROUP BY bot_name, (ts / 3600)
  `).run(from);
  getDb().prepare(`
    INSERT OR REPLACE INTO hik_hourly (bot_name, hour_ts, samples, ev_total, ev_motion, ev_video_loss, ev_tamper, ev_other, covered_sec)
    SELECT bot_name, (ts / 3600) * 3600, COUNT(*), SUM(ev_total), SUM(ev_motion), SUM(ev_video_loss), SUM(ev_tamper), SUM(ev_other), SUM(window_sec)
    FROM hik_samples WHERE ts >= ? GROUP BY bot_name, (ts / 3600)
  `).run(from);
}

function pruneDetail() {
  const now = Math.floor(Date.now() / 1000);
  const rawCut = now - DETAIL_RAW_RETENTION_DAYS * 86400;
  const hourCut = now - DETAIL_HOURLY_RETENTION_DAYS * 86400;
  const d = getDb();
  // สรุปชั่วโมงให้ครบก่อนลบดิบ (กรณี manager ดับข้ามวัน)
  rollupDetailHourly(rawCut - 3600);
  let removed = 0;
  for (const tbl of ['omada_samples', 'omada_top_clients', 'hik_samples', 'hik_top_cameras']) {
    removed += d.prepare(`DELETE FROM ${tbl} WHERE ts < ?`).run(rawCut).changes;
  }
  for (const tbl of ['omada_hourly', 'hik_hourly']) {
    removed += d.prepare(`DELETE FROM ${tbl} WHERE hour_ts < ?`).run(hourCut).changes;
  }
  logger.info(`stats-db: pruneDetail — removed ${removed} row(s) (raw>${DETAIL_RAW_RETENTION_DAYS}d, hourly>${DETAIL_HOURLY_RETENTION_DAYS}d)`);
  return removed;
}

// ts ล่าสุดที่เขียน section สำเร็จ — poller ใช้เป็นต้นหน้าต่างรอบแรกหลัง manager restart
function getLastDetailTs(botName) {
  const q = (tbl, extra = '') => {
    const r = getDb().prepare(`SELECT MAX(ts) AS ts FROM ${tbl} WHERE bot_name = ? ${extra}`).get(botName);
    return r && r.ts != null ? r.ts : null;
  };
  return { omadaTraffic: q('omada_samples', 'AND window_sec IS NOT NULL'), hikEvents: q('hik_samples') };
}

// ── ช่วงเวลาและขนาด bucket ของกราฟ ──
// 24h → ดิบ 5 นาที | 7d → รายชั่วโมง | 30d → ทีละ 6 ชั่วโมง
// หมายเหตุ: better-sqlite3 ผูกตัวเลข JS เป็น REAL เสมอ → ต้อง CAST(@b AS INTEGER) ไม่งั้น ts / @b เป็นการหารทศนิยม
// แล้ว GROUP BY ไม่รวม bucket (ได้จุดเท่าข้อมูลดิบ) — ห้ามใช้ @b ตรง ๆ ในนิพจน์หารจำนวนเต็ม
const RANGES = { '24h': { sec: 86400, bucket: 300 }, '7d': { sec: 7 * 86400, bucket: 3600 }, '30d': { sec: 30 * 86400, bucket: 6 * 3600 } };
function resolveRange(range) {
  return RANGES[range] ? { key: range, ...RANGES[range] } : { key: '24h', ...RANGES['24h'] };
}

// ชุดพื้นฐานจาก samples เดิม (problems แยกความรุนแรง + จำนวนอุปกรณ์) — ใช้ทั้งแท็บ Zabbix/Omada/HikCentral
function getBaseSeries(botName, range) {
  const r = resolveRange(range);
  const from = Math.floor(Date.now() / 1000) - r.sec;
  if (r.key === '24h') {
    return { bucketSec: r.bucket, points: getDb().prepare(`
      SELECT ts AS t, state, problems_total, problems_disaster, problems_high, problems_average, problems_warning,
             hosts_total, hosts_up, aps_total, aps_up, switches_total, switches_up, cameras_total, cameras_up
      FROM samples WHERE bot_name = ? AND ts >= ? ORDER BY ts ASC
    `).all(botName, from) };
  }
  return { bucketSec: r.bucket, points: getDb().prepare(`
    SELECT (ts / CAST(@b AS INTEGER)) * CAST(@b AS INTEGER) AS t,
           AVG(problems_total) AS problems_total, AVG(problems_disaster) AS problems_disaster, AVG(problems_high) AS problems_high,
           AVG(problems_average) AS problems_average, AVG(problems_warning) AS problems_warning,
           AVG(hosts_total) AS hosts_total, AVG(hosts_up) AS hosts_up, AVG(aps_total) AS aps_total, AVG(aps_up) AS aps_up,
           AVG(switches_total) AS switches_total, AVG(switches_up) AS switches_up,
           AVG(cameras_total) AS cameras_total, AVG(cameras_up) AS cameras_up
    FROM samples WHERE bot_name = @bot AND ts >= @from AND state = 'up'
    GROUP BY t ORDER BY t ASC
  `).all({ b: r.bucket, bot: botName, from }) };
}

function getOmadaSeries(botName, range) {
  const r = resolveRange(range);
  const from = Math.floor(Date.now() / 1000) - r.sec;
  if (r.key === '24h') {
    return { bucketSec: r.bucket, points: getDb().prepare(`
      SELECT ts AS t, clients_total AS clients, clients_total AS clients_max, clients_wireless AS wireless, clients_wired AS wired,
             clients_2g AS c2g, clients_5g AS c5g, clients_6g AS c6g, clients_guest AS guest,
             ap_tx, ap_rx, sw_tx, sw_rx, power_w AS power, window_sec
      FROM omada_samples WHERE bot_name = ? AND ts >= ? ORDER BY ts ASC
    `).all(botName, from) };
  }
  return { bucketSec: r.bucket, points: getDb().prepare(`
    SELECT (hour_ts / CAST(@b AS INTEGER)) * CAST(@b AS INTEGER) AS t, AVG(clients_avg) AS clients, MAX(clients_max) AS clients_max, AVG(wireless_avg) AS wireless, AVG(wired_avg) AS wired,
           AVG(c2g_avg) AS c2g, AVG(c5g_avg) AS c5g, AVG(c6g_avg) AS c6g, AVG(guest_avg) AS guest,
           SUM(ap_tx) AS ap_tx, SUM(ap_rx) AS ap_rx, SUM(sw_tx) AS sw_tx, SUM(sw_rx) AS sw_rx, AVG(power_avg) AS power, SUM(covered_sec) AS window_sec
    FROM omada_hourly WHERE bot_name = @bot AND hour_ts >= @from GROUP BY t ORDER BY t ASC
  `).all({ b: r.bucket, bot: botName, from }) };
}

function getHikSeries(botName, range) {
  const r = resolveRange(range);
  const from = Math.floor(Date.now() / 1000) - r.sec;
  if (r.key === '24h') {
    return { bucketSec: r.bucket, points: getDb().prepare(`
      SELECT ts AS t, ev_total AS total, ev_motion AS motion, ev_video_loss AS video_loss, ev_tamper AS tamper, ev_other AS other, window_sec
      FROM hik_samples WHERE bot_name = ? AND ts >= ? ORDER BY ts ASC
    `).all(botName, from) };
  }
  return { bucketSec: r.bucket, points: getDb().prepare(`
    SELECT (hour_ts / CAST(@b AS INTEGER)) * CAST(@b AS INTEGER) AS t, SUM(ev_total) AS total, SUM(ev_motion) AS motion, SUM(ev_video_loss) AS video_loss,
           SUM(ev_tamper) AS tamper, SUM(ev_other) AS other, SUM(covered_sec) AS window_sec
    FROM hik_hourly WHERE bot_name = @bot AND hour_ts >= @from GROUP BY t ORDER BY t ASC
  `).all({ b: r.bucket, bot: botName, from }) };
}

// อันดับ client ตามปริมาณที่ "เพิ่มขึ้น" ในช่วงเวลา — ค่าใน DB เป็นยอดสะสมตั้งแต่เชื่อมต่อ
// จึงรวมเฉพาะส่วนต่างระหว่าง sample ที่ติดกัน (ค่าลดลง = session รีเซ็ต นับค่าใหม่เป็นส่วนเพิ่ม)
// ประมาณการ: client ต้องอยู่ใน top 10 ของ sample หลายรอบจึงมีส่วนต่าง; จำกัดช่วงไม่เกิน raw retention
function getTopClients(botName, range, n = 10) {
  const r = resolveRange(range);
  const sec = Math.min(r.sec, DETAIL_RAW_RETENTION_DAYS * 86400);
  const from = Math.floor(Date.now() / 1000) - sec;
  const rows = getDb().prepare(`
    SELECT ts, mac, name, ap, down, up FROM omada_top_clients
    WHERE bot_name = ? AND ts >= ? ORDER BY ts ASC, rank ASC
  `).all(botName, from);
  const delta = (now, last) => (last === null ? 0 : (now >= last ? now - last : now));
  const byKey = new Map();
  for (const row of rows) {
    const key = row.mac || row.name || '?';
    const cur = byKey.get(key) || { mac: row.mac, name: row.name, ap: row.ap, down: 0, up: 0, lastDown: null, lastUp: null };
    cur.down += delta(row.down || 0, cur.lastDown);
    cur.up   += delta(row.up || 0, cur.lastUp);
    cur.lastDown = row.down || 0;
    cur.lastUp = row.up || 0;
    cur.name = row.name || cur.name;
    cur.ap = row.ap || cur.ap;
    byKey.set(key, cur);
  }
  return [...byKey.values()]
    .map(({ mac, name, ap, down, up }) => ({ mac, name, ap, down, up, total: down + up }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

function getTopCameras(botName, range, n = 5) {
  const r = resolveRange(range);
  const sec = Math.min(r.sec, DETAIL_RAW_RETENTION_DAYS * 86400);
  const from = Math.floor(Date.now() / 1000) - sec;
  return getDb().prepare(`
    SELECT cam_id AS id, MAX(cam_name) AS name, SUM(cnt) AS count FROM hik_top_cameras
    WHERE bot_name = ? AND ts >= ? GROUP BY cam_id ORDER BY count DESC LIMIT ?
  `).all(botName, from, n);
}

// sample ดิบล่าสุด (ไม่ขึ้นกับ range) — การ์ด "ตอนนี้" ในหน้า stats ใช้ค่านี้ ไม่ใช่ค่าเฉลี่ยของ bucket ท้ายสุดของ 7d/30d
function getLatest(botName) {
  const d = getDb();
  return {
    base: d.prepare(`
      SELECT ts AS t, problems_total, hosts_total, hosts_up, aps_total, aps_up, switches_total, switches_up, cameras_total, cameras_up
      FROM samples WHERE bot_name = ? AND state = 'up' ORDER BY ts DESC LIMIT 1
    `).get(botName) || null,
    omada: d.prepare(`
      SELECT ts AS t, clients_total AS clients, clients_wireless AS wireless, clients_wired AS wired, power_w AS power
      FROM omada_samples WHERE bot_name = ? AND clients_total IS NOT NULL ORDER BY ts DESC LIMIT 1
    `).get(botName) || null,
  };
}

function hasDetailData(botName) {
  const d = getDb();
  const has = (tbl) => !!d.prepare(`SELECT 1 FROM ${tbl} WHERE bot_name = ? LIMIT 1`).get(botName);
  return { omada: has('omada_hourly') || has('omada_samples'), hik: has('hik_hourly') || has('hik_samples') };
}

// ── Audit log ─────────────────────────────────────────────────────────────────
const AUDIT_RETENTION_DAYS = 365;

// row ต้องผ่าน services/audit.js (sanitize) มาก่อน — ที่นี่เขียนตรงๆ
function insertAudit({ ts = Math.floor(Date.now() / 1000), actor = null, ip = null, action, target = null, result, detail = null }) {
  getDb().prepare(`
    INSERT INTO audit_log (ts, actor, ip, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ts, actor, ip, action, target, result, detail);
}

// filters: { action (ตรงตัวหรือ prefix เช่น "bot."), result, limit (≤500), offset } — ใหม่สุดก่อน
function queryAudit({ action, result, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('action LIKE ?'); params.push(`${String(action).replace(/[%_\\]/g, '')}%`); }
  if (result) { where.push('result = ?'); params.push(String(result)); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = getDb().prepare(`
    SELECT id, ts, actor, ip, action, target, result, detail FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, lim, off);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...params).n;
  return { total, rows };
}

function pruneAudit() {
  const cutoff = Math.floor(Date.now() / 1000) - AUDIT_RETENTION_DAYS * 86400;
  const info = getDb().prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
  logger.info(`stats-db: pruneAudit — removed ${info.changes} row(s) older than ${AUDIT_RETENTION_DAYS} days`);
  return info.changes;
}

module.exports = {
  insertAudit,
  queryAudit,
  pruneAudit,
  insertDetail,
  rollupDetailHourly,
  pruneDetail,
  getLastDetailTs,
  getBaseSeries,
  getOmadaSeries,
  getHikSeries,
  getTopClients,
  getTopCameras,
  hasDetailData,
  getLatest,
  resolveRange,
  initDb,
  closeDb,
  insertSample,
  getSamples,
  getLastSampleTs,
  getDailyStats,
  getUptimeSummary,
  rollupDaily,
  pruneOldSamples,
  fillUnknownGaps,
};
