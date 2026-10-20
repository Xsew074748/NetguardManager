const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const logger = require('./services/logger');
const guard = require('./middleware/guard');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const statsDb = require('./services/stats-db');
const poller = require('./services/poller');

const app = express();
const publicDir = path.join(__dirname, 'public');

app.use(express.json());
app.use(cookieParser());
app.use(guard.networkGuard);

function serveIndex(req, res) {
  const token = req.cookies && req.cookies[guard.SESSION_COOKIE];
  if (!guard.isValidSession(token)) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(publicDir, 'index.html'));
}

app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(express.static(publicDir, { index: false }));

app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);

statsDb.initDb();
poller.startPolling().catch((err) => logger.error('poller: startPolling ล้มเหลว', err.message));

const server = app.listen(config.port, () => {
  logger.info(`NetGuard Manager listening on port ${config.port}`);
  require('./services/docker').getAutoTunnelService(); // log สถานะฟีเจอร์ Cloudflare auto-tunnel (ปิดเป็นค่าเริ่มต้น) ตอนเริ่ม
});

function shutdown(signal) {
  logger.info(`NetGuard Manager received ${signal} — shutting down`);
  poller.stopPolling();
  statsDb.closeDb();
  server.close(() => process.exit(0));
  // เผื่อ server.close() ค้าง (มี connection เปิดอยู่นาน) — บังคับออกหลัง 5 วิ
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
