const express = require('express');
const guard = require('../middleware/guard');
const dockerService = require('../services/docker');
const metaService = require('../services/meta');
const envConfigService = require('../services/env-config');
const dailySummaryConfig = require('../services/daily-summary-config');
const statsDb = require('../services/stats-db');
const poller = require('../services/poller');
const logger = require('../services/logger');

const router = express.Router();

router.use(guard.networkGuard, guard.requireAuth);

function handleError(res, err, fallbackMsg) {
  const status = err.statusCode || 500;
  if (status >= 500) {
    logger.error(`${fallbackMsg}:`, err.message);
  } else {
    logger.warn(`${fallbackMsg}:`, err.message);
  }
  res.status(status).json({ error: err.message || fallbackMsg });
}

router.get('/bots', async (req, res) => {
  try {
    const bots = await dockerService.listBots();
    res.json(bots);
  } catch (err) {
    handleError(res, err, 'Failed to list bots');
  }
});

router.get('/bots/:id/logs', async (req, res) => {
  try {
    const lines = parseInt(req.query.lines, 10) || 50;
    const logs = await dockerService.getBotLogs(req.params.id, lines);
    res.json(logs);
  } catch (err) {
    handleError(res, err, `Failed to get logs for ${req.params.id}`);
  }
});

router.get('/bots/:id/health', async (req, res) => {
  try {
    const health = await dockerService.getBotHealth(req.params.id);
    res.json(health);
  } catch (err) {
    handleError(res, err, `Failed to get health for ${req.params.id}`);
  }
});

// live snapshot จากตัว bot เอง (aiProvider, monitors, partial, failed) — คนละตัวกับ
// /bots/:name/stats/summary|daily|samples ด้านล่างที่เป็นสถิติ uptime ย้อนหลังจาก SQLite
router.get('/bots/:id/live-stats', async (req, res) => {
  try {
    const stats = await dockerService.getBotStats(req.params.id);
    res.json(stats);
  } catch (err) {
    handleError(res, err, `Failed to get live stats for ${req.params.id}`);
  }
});

const TEST_SYSTEMS = ['zabbix', 'omada', 'hikcentral', 'claude', 'gemini', 'openai'];

// ทดสอบ credentials ผ่าน bot container — ห้าม log body (มี secret) log แค่ botId + system
router.post('/bots/:id/test-connection', async (req, res) => {
  const { system, config: testConfig } = req.body || {};
  if (typeof system !== 'string' || !TEST_SYSTEMS.includes(system)) {
    return res.status(400).json({ ok: false, message: 'system ไม่ถูกต้อง' });
  }
  if (!testConfig || typeof testConfig !== 'object' || Array.isArray(testConfig) || Object.keys(testConfig).length === 0) {
    return res.status(400).json({ ok: false, message: 'config ต้องเป็น object และไม่ว่าง' });
  }
  try {
    logger.info(`test-connection: bot=${req.params.id} system=${system}`);
    res.json(await dockerService.testBotConnection(req.params.id, system, testConfig));
  } catch (err) {
    logger.warn(`test-connection: bot=${req.params.id} system=${system} failed (status ${err.statusCode || 500})`);
    res.status(err.statusCode || 500).json({
      ok: false,
      message: err.statusCode === 404 ? 'ไม่พบ bot' : 'ทดสอบไม่สำเร็จ ลองใหม่อีกครั้ง',
    });
  }
});

router.post('/bots', async (req, res) => {
  try {
    const { name, port, tunnelToken, companyName, image } = req.body || {};
    const bot = await dockerService.createBot({ name, port, tunnelToken, companyName, image });
    res.status(201).json(bot);
  } catch (err) {
    handleError(res, err, 'Failed to create bot');
  }
});

router.post('/bots/:id/start', async (req, res) => {
  try {
    await dockerService.startBot(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, `Failed to start ${req.params.id}`);
  }
});

router.post('/bots/:id/stop', async (req, res) => {
  try {
    await dockerService.stopBot(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, `Failed to stop ${req.params.id}`);
  }
});

router.post('/bots/:id/restart', async (req, res) => {
  try {
    await dockerService.restartBot(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, `Failed to restart ${req.params.id}`);
  }
});

router.delete('/bots/:id', async (req, res) => {
  try {
    const deleteFiles = req.query.deleteFiles === 'true';
    await dockerService.removeBot(req.params.id, { deleteFiles });
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, `Failed to remove ${req.params.id}`);
  }
});

router.post('/image/pull', async (req, res) => {
  try {
    await dockerService.pullLatestImage();
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 'Failed to pull latest image');
  }
});

function requireValidBotName(req, res) {
  if (!dockerService.isValidBotName(req.params.name)) {
    res.status(400).json({ error: 'Invalid bot name' });
    return false;
  }
  return true;
}

router.post('/bots/:name/tunnel', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const { token } = req.body || {};
    await dockerService.attachTunnel(req.params.name, token);
    res.status(201).json({ ok: true });
  } catch (err) {
    handleError(res, err, `Failed to attach tunnel for ${req.params.name}`);
  }
});

router.delete('/bots/:name/tunnel', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    await dockerService.detachTunnel(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, `Failed to detach tunnel for ${req.params.name}`);
  }
});

router.get('/bots/:name/meta', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const meta = metaService.readMeta(req.params.name);
    res.json(meta);
  } catch (err) {
    handleError(res, err, `Failed to read meta for ${req.params.name}`);
  }
});

router.put('/bots/:name/meta', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const meta = metaService.writeMeta(req.params.name, req.body || {});
    res.json(meta);
  } catch (err) {
    handleError(res, err, `Failed to update meta for ${req.params.name}`);
  }
});

router.get('/bots/:name/config', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const cfg = envConfigService.readEnvConfig(req.params.name);
    res.json(cfg);
  } catch (err) {
    handleError(res, err, `Failed to read config for ${req.params.name}`);
  }
});

router.put('/bots/:name/config', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const result = envConfigService.writeEnvConfig(req.params.name, req.body || {});
    logger.info(`config updated for ${req.params.name}: ${result.changed.join(', ')}`);
    res.json({ ok: true, changed: result.changed });
  } catch (err) {
    handleError(res, err, `Failed to update config for ${req.params.name}`);
  }
});

// ── เวลาแจ้งเตือนสรุปประจำวัน (เก็บใน data/settings.json ของ bot; bot ตั้ง cron ใหม่ทันทีผ่าน reload) ──
function describeLive(call) {
  if (!call.reachable) return { reachable: false, reason: call.reason };
  if (call.status === 404) return { reachable: true, supported: false };
  const d = call.data || {};
  return { reachable: true, supported: true, ok: call.status === 200 && d.ok !== false, times: d.times, nextRun: d.nextRun, error: d.error };
}

router.get('/bots/:name/daily-summary', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const saved = dailySummaryConfig.readTimes(req.params.name);
    const live = describeLive(await dockerService.callBot(req.params.name, 'GET', '/api/daily-summary/schedule'));
    res.json({ ...saved, live });
  } catch (err) {
    handleError(res, err, `Failed to read daily-summary for ${req.params.name}`);
  }
});

router.put('/bots/:name/daily-summary', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const saved = dailySummaryConfig.writeTimes(req.params.name, (req.body || {}).times);
    logger.info(`daily-summary times updated for ${req.params.name}: ${saved.times.join(', ')}`);
    const live = describeLive(await dockerService.callBot(req.params.name, 'POST', '/api/daily-summary/reload'));
    const applied = !!(live.reachable && live.supported && live.ok);
    let note = 'ตั้งเวลาใหม่ให้ bot ทันทีแล้ว (ไม่ต้อง restart)';
    if (!applied) {
      if (!live.reachable) note = 'บันทึกแล้ว แต่ bot ไม่ได้ทำงานอยู่ — จะใช้เวลานี้ตอน bot start';
      else if (!live.supported) note = 'บันทึกแล้ว แต่ bot ยังใช้ image เก่า (ไม่รองรับตั้งเวลาสรุปประจำวัน) — ต้องอัปเดต image และ recreate bot';
      else note = `บันทึกแล้ว แต่ bot ตั้งเวลาใหม่ไม่สำเร็จ: ${live.error || 'ไม่ทราบสาเหตุ'}`;
    }
    res.json({ ok: true, times: saved.times, applied, live, note });
  } catch (err) {
    handleError(res, err, `Failed to update daily-summary for ${req.params.name}`);
  }
});

router.get('/bots/:name/stats/summary', (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    res.json(statsDb.getUptimeSummary(req.params.name));
  } catch (err) {
    handleError(res, err, `Failed to get stats summary for ${req.params.name}`);
  }
});

router.get('/bots/:name/stats/samples', (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    let hours = parseInt(req.query.hours, 10);
    if (!Number.isInteger(hours) || hours <= 0) hours = 24;
    hours = Math.min(hours, 168);
    const now = Math.floor(Date.now() / 1000);
    res.json(statsDb.getSamples(req.params.name, now - hours * 3600, now));
  } catch (err) {
    handleError(res, err, `Failed to get samples for ${req.params.name}`);
  }
});

router.get('/bots/:name/stats/daily', (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isInteger(days) || days <= 0) days = 30;
    days = Math.min(days, 90);
    res.json(statsDb.getDailyStats(req.params.name, days));
  } catch (err) {
    handleError(res, err, `Failed to get daily stats for ${req.params.name}`);
  }
});

// ข้อมูลกราฟสำหรับ stats modal แบบแท็บ (Zabbix / Omada / HikCentral) — ?range=24h|7d|30d
// แท็บไหนไม่มีข้อมูล/bot ไม่ได้เปิด monitor นั้น → available:false ให้ frontend ซ่อน (ไม่ hardcode ชื่อ bot)
router.get('/bots/:name/stats/series', (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const name = req.params.name;
    const range = statsDb.resolveRange(req.query.range).key;
    const live = poller.getDetailStatus(name); // null = manager ยังไม่เคย poll bot นี้ตั้งแต่ start
    const monitors = live ? live.monitors : null;
    const has = statsDb.hasDetailData(name);
    const base = statsDb.getBaseSeries(name, range);

    const omadaOn = has.omada || (monitors && monitors.includes('omada'));
    const hikOn = has.hik || (monitors && monitors.includes('hikcentral'));
    const zabbixOn = (monitors && monitors.includes('zabbix')) || base.points.some((p) => p.problems_total != null || p.hosts_total != null);

    res.json({
      range,
      bucketSec: base.bucketSec,
      detail: live,
      latest: statsDb.getLatest(name),
      zabbix: { available: !!zabbixOn, ...base },
      omada: {
        available: !!omadaOn,
        ...(omadaOn ? { ...statsDb.getOmadaSeries(name, range), topClients: statsDb.getTopClients(name, range) } : { points: [], topClients: [] }),
      },
      hikcentral: {
        available: !!hikOn,
        ...(hikOn ? { ...statsDb.getHikSeries(name, range), topCameras: statsDb.getTopCameras(name, range) } : { points: [], topCameras: [] }),
      },
    });
  } catch (err) {
    handleError(res, err, `Failed to get stats series for ${req.params.name}`);
  }
});

router.get('/bots/:name/tunnel/logs', async (req, res) => {
  if (!requireValidBotName(req, res)) return;
  try {
    const lines = parseInt(req.query.lines, 10) || 50;
    const logs = await dockerService.getBotLogs(`netguard-${req.params.name}-cloudflared`, lines);
    res.json(logs);
  } catch (err) {
    handleError(res, err, `Failed to get tunnel logs for ${req.params.name}`);
  }
});

module.exports = router;
