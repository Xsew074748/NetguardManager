const express = require('express');
const guard = require('../middleware/guard');
const { createLoginLimiters, createPasswordChangeLimiter } = require('../middleware/login-limit');
const { requireSameOrigin } = require('../middleware/csrf-guard');
const { createPasswordChanger } = require('../services/password-change');
const audit = require('../services/audit');
const logger = require('../services/logger');
const config = require('../config');

function setSessionCookie(req, res, token) {
  res.cookie(guard.SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production' && req.secure,
    maxAge: 24 * 60 * 60 * 1000,
  });
}

// hashOpts: ค่า scrypt ที่ฉีดได้ (เทสต์ใช้ค่าเบา — production ไม่ส่ง = ค่าเริ่มต้น N=2^15)
// passwordLimiter: { max, windowMs } ของ limiter เปลี่ยนรหัส (ค่าเริ่มต้น 5 ครั้งผิด/15 นาที รวมทั้งระบบ)
function createAuthRouter({ hashOpts, passwordLimiter } = {}) {
  const router = express.Router();

  // ล็อก login ที่ผิด: 5 ครั้ง/15 นาที/IP + เพดานรวม 20 ครั้ง/15 นาที (ดูเหตุผลใน middleware/login-limit.js)
  const loginLimiters = createLoginLimiters({
    onBlocked: (req, scope) => {
      logger.warn(`Login blocked (${scope} limit) from ${req.ip}`);
      audit.record({ req, actor: 'anonymous', action: 'auth.login-locked', result: 'denied', detail: { scope } });
    },
  });

  const passwordChanger = createPasswordChanger({ hashOpts });
  const changeLimiter = createPasswordChangeLimiter({
    ...(passwordLimiter || {}),
    onBlocked: (req) => {
      logger.warn('Password change blocked (rate limit)');
      audit.record({ req, action: 'auth.password-change-locked', result: 'denied' });
    },
  });
  const csrf = requireSameOrigin({
    onReject: (req, reason) => {
      logger.warn(`Password change blocked (csrf: ${reason})`);
      audit.record({ req, action: 'auth.password-change', result: 'denied', detail: { reason: 'csrf' } });
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

    setSessionCookie(req, res, token);
    res.json({ loggedIn: true });
  });

  router.post('/logout', (req, res) => {
    const token = req.cookies && req.cookies[guard.SESSION_COOKIE];
    if (guard.isValidSession(token)) audit.record({ req, action: 'auth.logout', result: 'ok' });
    guard.destroySession(token);
    res.clearCookie(guard.SESSION_COOKIE);
    res.json({ loggedIn: false });
  });

  // เปลี่ยนรหัสผ่าน (ต้อง login): requireAuth → CSRF (2 ชั้น) → limiter (ก่อนแตะ scrypt) → ตรวจรูปแบบ → ล็อก/เปลี่ยน
  // รหัสเดิมผิดต้องตอบ 403 (ห้าม 401: public/js/api.js เด้งไป login.html ทุกครั้งที่ได้ 401)
  // ห้าม log/audit ค่ารหัสผ่านใดๆ — audit เก็บแค่เหตุผลสั้น
  router.post('/password', guard.requireAuth, csrf, changeLimiter, async (req, res) => {
    const bad = passwordChanger.validateRequest(req.body);
    if (bad) {
      audit.record({ req, action: 'auth.password-change', result: 'fail', detail: { reason: bad.reason } });
      return res.status(bad.status).json({ error: bad.error });
    }

    const { current, next } = req.body;
    const result = await passwordChanger.change(current, next);
    if (!result.ok) {
      logger.warn(`Password change failed (${result.reason})`);
      audit.record({ req, action: 'auth.password-change', result: 'fail', detail: { reason: result.reason } });
      return res.status(result.status).json({ error: result.error });
    }

    // ผู้เปลี่ยนอยู่ต่อด้วย session ใหม่ ส่วน session อื่นทั้งหมดถูกยกเลิก (changedAt ใน auth.json ยกเลิกข้าม process ด้วย)
    guard.destroyAllSessions();
    const token = guard.createSession();
    setSessionCookie(req, res, token);
    logger.info('auth: เปลี่ยนรหัสผ่านผ่านเว็บแล้ว');
    audit.record({ req, actor: guard.sessionActor(token), action: 'auth.password-change', result: 'ok' });
    res.json({ changed: true, envHashStale: guard.isEnvHashStale() });
  });

  router.get('/status', (req, res) => {
    const token = req.cookies && req.cookies[guard.SESSION_COOKIE];
    const loggedIn = guard.isValidSession(token);
    // weakPassword / envHashStale: เปิดเผยเฉพาะผู้ที่ login แล้ว (banner เตือนให้เปลี่ยนรหัส / hash ใน .env ล้าสมัย)
    // envHashStale ใส่เฉพาะตอนเป็นจริง (ไม่ใส่ false) เพื่อไม่เปลี่ยนรูปแบบ response เดิม
    res.json({
      loggedIn,
      ...(loggedIn ? { weakPassword: guard.isPasswordWeak() } : {}),
      ...(loggedIn && guard.isEnvHashStale() ? { envHashStale: true } : {}),
    });
  });

  return router;
}

module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
