const fs = require('fs');
const path = require('path');
const config = require('../config');
const dockerService = require('./docker');

const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const MAX_VALUE_LEN = 500;

// whitelist เท่านั้น — key อื่นใน .env (เช่น CLOUDFLARE_TUNNEL_TOKEN ที่จัดการ
// ผ่านปุ่ม Tunnel อยู่แล้ว) จะไม่ถูกอ่าน/เขียนผ่าน service นี้เลย
const FIELDS = {
  LINE_CHANNEL_SECRET: { secret: true },
  LINE_CHANNEL_ACCESS_TOKEN: { secret: true },
  ZABBIX_URL: { url: true },
  ZABBIX_API_TOKEN: { secret: true },
  OMADA_URL: { url: true },
  OMADA_OMADAC_ID: {},
  OMADA_CLIENT_ID: {},
  OMADA_CLIENT_SECRET: { secret: true },
  OMADA_SITE_ID: {},
  HIKCENTRAL_URL: { url: true },
  HIKCENTRAL_APP_KEY: {},
  HIKCENTRAL_APP_SECRET: { secret: true },
  AI_PROVIDER: { enumValues: ['claude', 'gemini', 'openai'], default: 'claude' },
  ANTHROPIC_API_KEY: { secret: true },
  GEMINI_API_KEY: { secret: true },
  OPENAI_API_KEY: { secret: true },
};

function validationError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function envPath(botName) {
  if (typeof botName !== 'string' || !BOT_NAME_RE.test(botName)) {
    throw validationError('Invalid bot name');
  }
  const root = path.resolve(config.botsRoot);
  const target = path.resolve(root, botName);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw validationError('Invalid bot name');
  }
  return path.join(target, '.env');
}

function parseEnv(content) {
  const result = {};
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    result[key] = trimmed.slice(idx + 1);
  });
  return result;
}

// คืนเฉพาะ field ใน FIELDS — field ธรรมดาคืนค่าจริง, field secret คืนแค่
// { set, hint } ห้ามคืนค่าเต็มเด็ดขาด
function readEnvConfig(botName) {
  const filePath = envPath(botName);
  const parsed = fs.existsSync(filePath) ? parseEnv(fs.readFileSync(filePath, 'utf8')) : {};

  const out = {};
  for (const [key, meta] of Object.entries(FIELDS)) {
    const raw = parsed[key] || '';
    if (meta.secret) {
      out[key] = raw ? { set: true, hint: `••••${raw.slice(-4)}` } : { set: false, hint: '' };
    } else {
      out[key] = raw || (meta.default !== undefined ? meta.default : '');
    }
  }
  return out;
}

// updates[key]:
//   undefined / ไม่มี key นี้  → ไม่แตะ
//   ''  บน field secret        → ไม่แตะ (UI ไม่รู้ค่าเดิม เขียนทับด้วยค่าว่างจะลบโดยไม่ตั้งใจ)
//   null                       → ลบค่า (วิธีล้างแบบตั้งใจ)
//   string อื่น ๆ               → ตั้งค่าใหม่
function writeEnvConfig(botName, updates) {
  const filePath = envPath(botName);
  if (!updates || typeof updates !== 'object') {
    throw validationError('Invalid payload');
  }

  const changed = [];
  for (const [key, meta] of Object.entries(FIELDS)) {
    if (!(key in updates)) continue;
    const value = updates[key];

    if (value === null) {
      dockerService.setEnvValue(filePath, key, '');
      changed.push(key);
      continue;
    }
    if (typeof value !== 'string') {
      throw validationError(`Field "${key}" must be a string`);
    }

    // กรอง \r\n ออกก่อนเสมอ กัน env injection (ค่าที่มี newline จะสร้าง
    // บรรทัดใหม่ใน .env ได้ เช่น "abc\nANTHROPIC_API_KEY=evil")
    const cleaned = value.replace(/[\r\n]+/g, '').trim().slice(0, MAX_VALUE_LEN);

    if (meta.secret && cleaned === '') continue; // ไม่แตะค่าเดิม

    if (meta.url && cleaned !== '' && !/^https?:\/\//i.test(cleaned)) {
      throw validationError(`Field "${key}" must start with http:// or https://`);
    }

    if (meta.enumValues && cleaned !== '' && !meta.enumValues.includes(cleaned)) {
      throw validationError(`Field "${key}" must be one of: ${meta.enumValues.join(', ')}`);
    }

    dockerService.setEnvValue(filePath, key, cleaned);
    changed.push(key);
  }

  return { changed };
}

module.exports = {
  readEnvConfig,
  writeEnvConfig,
  FIELDS,
};
