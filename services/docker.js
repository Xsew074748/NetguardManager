const fs = require('fs');
const path = require('path');
const net = require('net');
const Docker = require('dockerode');
const config = require('../config');
const logger = require('./logger');
const metaService = require('./meta');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:latest';

const ENV_TEMPLATE = `# ---- LINE ----------------------------------------
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=

# ---- Zabbix ---------------------------------------
ZABBIX_URL=
ZABBIX_API_TOKEN=

# ---- Omada (Open API) ------------------------------
OMADA_URL=
OMADA_CLIENT_ID=
OMADA_CLIENT_SECRET=
OMADA_OMADAC_ID=
OMADA_SITE_ID=

# ---- HikCentral (AK/SK) -----------------------------
HIKCENTRAL_URL=
HIKCENTRAL_APP_KEY=
HIKCENTRAL_APP_SECRET=

# ---- Claude AI --------------------------------------
ANTHROPIC_API_KEY=

# ---- Cloudflare Tunnel -------------------------------
CLOUDFLARE_TUNNEL_TOKEN=
`;

function stripLeadingSlash(name) {
  return name.startsWith('/') ? name.slice(1) : name;
}

function findHostPort(ports) {
  const mapping = (ports || []).find((p) => p.PrivatePort === 3000 && p.PublicPort);
  return mapping ? mapping.PublicPort : null;
}

function validationError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isValidBotName(name) {
  return typeof name === 'string' && BOT_NAME_RE.test(name);
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function isValidTunnelToken(token) {
  return typeof token === 'string' && token.length > 20 && !/\s/.test(token);
}

function deriveBotName(labels, containerName) {
  return (labels && labels['netguard.botname']) || stripLeadingSlash(containerName).replace(/^netguard-/, '');
}

function setEnvValue(envPath, key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ENV_TEMPLATE;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content += `${content.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  }
  const tmpPath = `${envPath}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, envPath);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function assertManaged(container) {
  const detail = await container.inspect();
  const labels = (detail.Config && detail.Config.Labels) || {};
  const managed = labels['netguard.managed'] === 'true' || detail.Config.Image === config.botImage;
  if (!managed) {
    throw validationError('Refusing to operate on a container not managed by NetGuard Manager', 403);
  }
  return detail;
}

async function getTunnelStatus(botName) {
  const tunnelName = `netguard-${botName}-cloudflared`;
  try {
    const detail = await docker.getContainer(tunnelName).inspect();
    return { exists: true, state: detail.State.Status, status: detail.State.Status };
  } catch (err) {
    if (err.statusCode === 404) return { exists: false };
    throw err;
  }
}

async function listBots() {
  const containers = await docker.listContainers({ all: true });
  const bots = containers.filter((c) => {
    // เฉพาะ label เท่านั้น — ไม่ fallback ไป image name เพราะ container อื่น
    // ที่ใช้ image เดียวกันโดยบังเอิญ (เช่น bot ที่ติดตั้งผ่าน install.sh
    // ไม่ผ่าน manager) ไม่ควรถูก manager คุม/poll ด้วย
    const managed = c.Labels && c.Labels['netguard.managed'] === 'true';
    const isTunnel = c.Labels && c.Labels['netguard.role'] === 'tunnel';
    return managed && !isTunnel;
  });

  return Promise.all(
    bots.map(async (c) => {
      let health = null;
      try {
        const detail = await docker.getContainer(c.Id).inspect();
        health = detail.State && detail.State.Health ? detail.State.Health.Status : null;
      } catch (err) {
        logger.warn(`inspect failed for container ${c.Id}:`, err.message);
      }

      const botName = deriveBotName(c.Labels, (c.Names && c.Names[0]) || c.Id);
      let tunnel = { exists: false };
      try {
        tunnel = await getTunnelStatus(botName);
      } catch (err) {
        logger.warn(`tunnel status lookup failed for "${botName}":`, err.message);
      }

      return {
        id: c.Id,
        name: stripLeadingSlash((c.Names && c.Names[0]) || c.Id),
        state: c.State,
        status: c.Status,
        port: findHostPort(c.Ports),
        createdAt: new Date(c.Created * 1000).toISOString(),
        health,
        tunnel,
        meta: metaService.readMeta(botName),
      };
    })
  );
}

function demuxLogBuffer(buffer) {
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    lines.push(buffer.slice(start, end).toString('utf8'));
    offset = end;
  }
  if (lines.length === 0 && buffer.length > 0) {
    return buffer.toString('utf8').split('\n').filter(Boolean);
  }
  return lines.join('').split('\n').filter(Boolean);
}

async function getBotLogs(id, lines = 50) {
  const container = docker.getContainer(id);
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail: lines,
    timestamps: false,
    follow: false,
  });
  return demuxLogBuffer(buffer);
}

async function fetchHealth(host) {
  const res = await fetch(`http://${host}:3000/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

async function getBotHealth(containerId) {
  const container = docker.getContainer(containerId);
  const detail = await container.inspect();

  if (!detail.State.Running) {
    return { ok: false, reason: 'stopped' };
  }

  const containerName = stripLeadingSlash(detail.Name);
  const networks = detail.NetworkSettings.Networks || {};
  const ip = (networks[config.botNetwork] && networks[config.botNetwork].IPAddress)
    || Object.values(networks).map((n) => n.IPAddress).find(Boolean);

  // Prefer the container name — Docker's embedded DNS resolves it on any
  // user-defined network they share, and unlike the IP it survives restarts.
  let lastErr;
  for (const host of [containerName, ip].filter(Boolean)) {
    try {
      const data = await fetchHealth(host);
      return { ok: true, monitorsLoaded: data.monitorsLoaded || [] };
    } catch (err) {
      lastErr = err;
    }
  }

  if (!containerName && !ip) return { ok: false, reason: 'no-ip' };
  return { ok: false, reason: lastErr ? lastErr.message : 'unreachable' };
}

async function fetchStats(host) {
  // /stats ของ bot เองมี per-monitor timeout 4000ms (services/stats.js ของ LineBot)
  // ยิง Zabbix/Omada/HikCentral จริงตอน cache ฝั่ง bot หมดอายุ (ทุก 60 วิ) — ถ้า monitor
  // ไหน timeout จริง response อาจช้าเกือบ 4-5 วิ ต้องให้ timeout ฝั่งนี้ยาวกว่านั้นเสมอ
  // ไม่งั้นจะ abort ก่อน bot ตอบทัน กลายเป็น false "ไม่มีข้อมูล" ทั้งที่ bot จะตอบได้จริง
  const res = await fetch(`http://${host}:3000/stats`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

// ดึง /stats สดจากตัว bot เอง (aiProvider, monitors, partial, failed) — คนละตัวกับ
// /api/bots/:name/stats/summary|daily|samples ที่เป็นสถิติ uptime ย้อนหลังจาก SQLite
// ของ manager เอง ไม่มีข้อมูลนี้เลย
async function getBotStats(containerId) {
  const container = docker.getContainer(containerId);
  const detail = await container.inspect();

  if (!detail.State.Running) return null;

  const containerName = stripLeadingSlash(detail.Name);
  const networks = detail.NetworkSettings.Networks || {};
  const ip = (networks[config.botNetwork] && networks[config.botNetwork].IPAddress)
    || Object.values(networks).map((n) => n.IPAddress).find(Boolean);

  for (const host of [containerName, ip].filter(Boolean)) {
    try {
      return await fetchStats(host);
    } catch (err) {
      // ลอง host ถัดไป (ip แทน container name) ก่อนยอมแพ้
    }
  }
  return null;
}

// ให้ bot ทดสอบ credentials ที่ยังไม่บันทึก (POST /test-connection ของ LineBot)
// ตั้งชื่อพารามิเตอร์ testConfig (ไม่ใช่ config) กันชนกับ module config ที่ใช้อ่าน botNetwork
// ห้าม log testConfig — มี secret
async function testBotConnection(containerId, system, testConfig) {
  const container = docker.getContainer(containerId);
  const detail = await container.inspect();
  if (!detail.State.Running) {
    return { ok: false, message: 'Bot ไม่ได้ทำงานอยู่ ต้อง Start ก่อนทดสอบ' };
  }

  const containerName = stripLeadingSlash(detail.Name);
  const networks = detail.NetworkSettings.Networks || {};
  const ip = (networks[config.botNetwork] && networks[config.botNetwork].IPAddress)
    || Object.values(networks).map((n) => n.IPAddress).find(Boolean);

  for (const host of [containerName, ip].filter(Boolean)) {
    try {
      // timeout ยาวกว่า fetchStats เพราะ bot ต้องยิงออกไปหาระบบภายนอกจริง (สูงสุด ~5 วิ, AI ~15 วิ)
      const res = await fetch(`http://${host}:3000/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, config: testConfig }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      return { ok: !!data.ok, message: String(data.message || '') };
    } catch (err) {
      // ลอง host ถัดไป
    }
  }
  return { ok: false, message: 'ติดต่อ bot ไม่ได้ ลองใหม่อีกครั้ง' };
}

async function createBot({ name, port, tunnelToken, companyName }) {
  if (!isValidBotName(name)) {
    throw validationError('Invalid bot name — use lowercase letters, numbers, and hyphens only (2-31 chars, must start with a letter or digit)');
  }
  const portNum = Number(port);
  if (!isValidPort(portNum)) {
    throw validationError('Invalid port — must be an integer between 1024 and 65535');
  }
  if (tunnelToken !== undefined && tunnelToken !== '' && !isValidTunnelToken(tunnelToken)) {
    throw validationError('Invalid tunnel token — must be longer than 20 characters with no whitespace');
  }
  if (!config.botsHostPath) {
    throw validationError('BOTS_HOST_PATH is not configured on the manager', 503);
  }

  try {
    await docker.getNetwork(config.botNetwork).inspect();
  } catch (err) {
    throw validationError(
      `Network "${config.botNetwork}" not found — start the manager with docker compose up first`,
      503
    );
  }

  const containerName = `netguard-${name}`;
  const existing = await listBots();
  if (existing.some((b) => b.name === containerName)) {
    throw validationError(`Bot name "${name}" already exists`, 409);
  }
  if (existing.some((b) => b.port === portNum)) {
    throw validationError(`Port ${portNum} is already used by another bot`, 409);
  }
  if (!(await isPortFree(portNum))) {
    throw validationError(`Port ${portNum} is already in use`, 409);
  }

  const botDir = path.join(config.botsRoot, name);
  fs.mkdirSync(path.join(botDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(botDir, 'logs'), { recursive: true });

  metaService.initMeta(name);
  if (companyName) {
    try {
      metaService.writeMeta(name, { companyName });
    } catch (err) {
      logger.warn(`Bot "${name}" created but failed to save companyName:`, err.message);
    }
  }

  const envPath = path.join(botDir, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, ENV_TEMPLATE);
  }
  if (tunnelToken) {
    setEnvValue(envPath, 'CLOUDFLARE_TUNNEL_TOKEN', tunnelToken);
  }

  const hostBotDir = `${config.botsHostPath}/${name}`;

  let container;
  try {
    container = await docker.createContainer({
      Image: config.botImage,
      name: containerName,
      Labels: {
        'netguard.managed': 'true',
        'netguard.botname': name,
      },
      HostConfig: {
        RestartPolicy: { Name: 'always' },
        PortBindings: { '3000/tcp': [{ HostPort: String(portNum) }] },
        Binds: [
          `${hostBotDir}/.env:/app/.env`,
          `${hostBotDir}/data:/app/data`,
          `${hostBotDir}/logs:/app/logs`,
        ],
      },
      ExposedPorts: { '3000/tcp': {} },
      NetworkingConfig: {
        EndpointsConfig: {
          [config.botNetwork]: {},
        },
      },
    });
    await container.start();
  } catch (err) {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (cleanupErr) {
        logger.warn(`Cleanup failed for container ${container.id}:`, cleanupErr.message);
      }
    }
    throw err;
  }

  if (tunnelToken) {
    try {
      await createTunnel(name, tunnelToken);
    } catch (err) {
      logger.warn(`Bot "${name}" created but tunnel setup failed:`, err.message);
    }
  }

  return { id: container.id, name: containerName, port: portNum };
}

async function startBot(id) {
  const container = docker.getContainer(id);
  const detail = await assertManaged(container);
  await container.start();
  await toggleTunnel(detail, 'start');
}

async function stopBot(id) {
  const container = docker.getContainer(id);
  const detail = await assertManaged(container);
  await container.stop();
  await toggleTunnel(detail, 'stop');
}

async function restartBot(id) {
  const container = docker.getContainer(id);
  const detail = await assertManaged(container);
  await container.restart();
  await toggleTunnel(detail, 'restart');
}

async function removeBot(id, { deleteFiles = false } = {}) {
  const container = docker.getContainer(id);
  const detail = await assertManaged(container);
  const labels = (detail.Config && detail.Config.Labels) || {};
  const botName = labels['netguard.botname'] || stripLeadingSlash(detail.Name).replace(/^netguard-/, '');

  const tunnelContainer = docker.getContainer(`netguard-${botName}-cloudflared`);
  try {
    await tunnelContainer.stop();
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
  try {
    await tunnelContainer.remove();
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  try {
    await container.stop();
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
  await container.remove();

  if (deleteFiles && botName) {
    const root = path.resolve(config.botsRoot);
    const target = path.resolve(root, botName);
    if (target === root || !target.startsWith(root + path.sep)) {
      logger.warn(`Skipped deleting files for "${botName}" — path traversal guard triggered`);
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2, output) => {
        if (err2) return reject(err2);
        resolve(output);
      });
    });
  });
}

async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
  } catch (err) {
    await pullImage(image);
  }
}

async function pullLatestImage() {
  return pullImage(config.botImage);
}

async function createTunnel(botName, token) {
  await ensureImage(CLOUDFLARED_IMAGE);
  const containerName = `netguard-${botName}-cloudflared`;
  const container = await docker.createContainer({
    Image: CLOUDFLARED_IMAGE,
    name: containerName,
    Labels: {
      'netguard.managed': 'true',
      'netguard.botname': botName,
      'netguard.role': 'tunnel',
    },
    Cmd: ['tunnel', '--no-autoupdate', 'run', '--token', token],
    HostConfig: {
      RestartPolicy: { Name: 'always' },
    },
    NetworkingConfig: {
      EndpointsConfig: { [config.botNetwork]: {} },
    },
  });
  await container.start();
  return { id: container.id, name: containerName };
}

async function toggleTunnel(botDetail, action) {
  const botName = deriveBotName((botDetail.Config && botDetail.Config.Labels) || {}, botDetail.Name);
  const tunnelContainer = docker.getContainer(`netguard-${botName}-cloudflared`);
  try {
    await tunnelContainer[action]();
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 304) return;
    logger.warn(`Failed to ${action} tunnel for "${botName}":`, err.message);
  }
}

async function attachTunnel(botName, token) {
  if (!isValidBotName(botName)) {
    throw validationError('Invalid bot name — use lowercase letters, numbers, and hyphens only (2-31 chars, must start with a letter or digit)');
  }
  if (!isValidTunnelToken(token)) {
    throw validationError('Invalid tunnel token — must be longer than 20 characters with no whitespace');
  }

  let botDetail;
  try {
    botDetail = await docker.getContainer(`netguard-${botName}`).inspect();
  } catch (err) {
    if (err.statusCode === 404) throw validationError(`Bot "${botName}" not found`, 404);
    throw err;
  }

  const existingTunnel = await getTunnelStatus(botName);
  if (existingTunnel.exists) {
    throw validationError(`Tunnel for "${botName}" already exists`, 409);
  }

  const envPath = path.join(config.botsRoot, botName, '.env');
  setEnvValue(envPath, 'CLOUDFLARE_TUNNEL_TOKEN', token);

  await createTunnel(botName, token);

  try {
    await docker.getContainer(botDetail.Id).restart();
  } catch (err) {
    logger.warn(`Failed to restart bot "${botName}" after attaching tunnel:`, err.message);
  }
}

async function detachTunnel(botName) {
  if (!isValidBotName(botName)) {
    throw validationError('Invalid bot name — use lowercase letters, numbers, and hyphens only (2-31 chars, must start with a letter or digit)');
  }

  const tunnelContainer = docker.getContainer(`netguard-${botName}-cloudflared`);
  try {
    await tunnelContainer.stop();
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
  try {
    await tunnelContainer.remove();
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  const envPath = path.join(config.botsRoot, botName, '.env');
  if (fs.existsSync(envPath)) {
    setEnvValue(envPath, 'CLOUDFLARE_TUNNEL_TOKEN', '');
  }
}

module.exports = {
  listBots,
  getBotLogs,
  getBotHealth,
  getBotStats,
  testBotConnection,
  createBot,
  startBot,
  stopBot,
  restartBot,
  removeBot,
  pullLatestImage,
  createTunnel,
  getTunnelStatus,
  attachTunnel,
  detachTunnel,
  isValidBotName,
  setEnvValue,
};
