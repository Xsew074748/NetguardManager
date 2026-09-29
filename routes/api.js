const express = require('express');
const guard = require('../middleware/guard');
const dockerService = require('../services/docker');
const metaService = require('../services/meta');
const envConfigService = require('../services/env-config');
const statsDb = require('../services/stats-db');
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

router.post('/bots', async (req, res) => {
  try {
    const { name, port, tunnelToken, companyName } = req.body || {};
    const bot = await dockerService.createBot({ name, port, tunnelToken, companyName });
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
