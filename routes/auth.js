const express = require('express');
const guard = require('../middleware/guard');
const { createLoginLimiters } = require('../middleware/login-limit');
const audit = require('../services/audit');
const logger = require('../services/logger');
const config = require('../config');

const router = express.Router();

// ล็อก login ที่ผิด: 5 ครั้ง/15 นาที/IP + เพดานรวม 20 ครั้ง/15 นาที (ดูเหตุผลใน middleware/login-limit.js)
const loginLimiters = createLoginLimiters({
  onBlocked: (req, scope) => {
    logger.warn(`Login blocked (${scope} limit) from ${req.ip}`);
    audit.record({ req, actor: 'anonymous', action: 'auth.login-locked', result: 'denied', detail: { scope } });
  },
});

router.use(guard.networkGuard);

router.post('/login', loginLimiters, async (req, res) => {
  const { password } = req.body || {};
  let result;
  try {
    result = await guard.authenticate(password);
  } catch (err) {
    logger.error(`login: authenticate ล้มเหลว: ${err.message}`);
    result = { ok: false, reason: 'error' };
  }

  if (!result.ok) {
    logger.warn(`Failed login attempt from ${req.ip} (${result.reason})`);
    audit.record({ req, actor: 'anonymous', action: 'auth.login', result: 'fail', detail: { reason: result.reason } });
    // ไม่บอกผู้เรียกว่าเพราะอะไร (ยกเว้นระบบยังไม่ได้ตั้งรหัส เพื่อให้แอดมินรู้ว่าต้องไปตั้ง)
    if (result.reason === 'no-hash-configured' || result.reason === 'unsupported-hash-format') {
      return res.status(503).json({ error: 'Login is disabled: no valid password is configured on the server' });
    }
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = guard.createSession();
  const actor = guard.sessionActor(token);
  audit.record({ req, actor, action: 'auth.login', result: 'ok' });
  if (result.migrated) {
    audit.record({ req, actor, action: 'auth.password-migrated', result: 'ok', detail: { from: 'sha256', to: 'scrypt' } });
  }
  if (result.weak) {
    audit.record({ req, actor, action: 'auth.weak-password', result: 'warn', detail: { minLength: 12 } });
  }

  res.cookie(guard.SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production' && req.secure,
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ loggedIn: true });
});

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies[guard.SESSION_COOKIE];
  if (guard.isValidSession(token)) audit.record({ req, action: 'auth.logout', result: 'ok' });
  guard.destroySession(token);
  res.clearCookie(guard.SESSION_COOKIE);
  res.json({ loggedIn: false });
});

router.get('/status', (req, res) => {
  const token = req.cookies && req.cookies[guard.SESSION_COOKIE];
  const loggedIn = guard.isValidSession(token);
  // weakPassword: เปิดเผยเฉพาะผู้ที่ login แล้ว (ใช้แสดง banner เตือนให้เปลี่ยนรหัส)
  res.json({ loggedIn, ...(loggedIn ? { weakPassword: guard.isPasswordWeak() } : {}) });
});

module.exports = router;
