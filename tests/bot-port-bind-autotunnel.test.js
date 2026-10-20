// BOT_PORT_BIND_HOST ร่วมกับ auto-tunnel: บอทที่สร้างทั้งทางธรรมดาและทาง autoTunnel ต้องได้ HostIp เหมือนกัน
// (สองงานแยก branch แล้วมารวมกัน — เทสต์นี้กันไม่ให้ทางใดทางหนึ่งหลุดไปเปิดทุก interface เงียบๆ)
// Docker จำลองด้วยการแทน method ของ dockerode prototype และ Cloudflare จำลอง — ไม่แตะ docker.sock/Cloudflare จริง ไม่ใช้ token จริง
// รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-bindauto-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.BOTS_HOST_PATH = '/host/bots';
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
delete process.env.BOT_PORT_BIND_HOST;
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const Docker = require('dockerode');
const config = require('../config');
const logger = require('../services/logger');
const realState = require('../services/cloudflare-state');
const { createAutoTunnelService } = require('../services/cloudflare-auto');
const dockerService = require('../services/docker');

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '11111111-2222-4333-8444-555555555555';
const REC = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'tunneltoken_BIND_SECRET_0123456789abcdefghij';
const SETTINGS = { enabled: true, accountId: ACCT, zoneId: ZONE, zoneName: 'example.com', reserved: [] };

const created = [];
const saved = {};
for (const key of ['getNetwork', 'listContainers', 'getImage', 'createContainer', 'getContainer']) saved[key] = Docker.prototype[key];
test.before(() => {
  Docker.prototype.getNetwork = () => ({ inspect: async () => ({}) });
  Docker.prototype.listContainers = async () => [];
  Docker.prototype.getImage = () => ({ inspect: async () => ({}) });
  Docker.prototype.createContainer = async (opts) => {
    created.push(opts);
    return { id: `id-${opts.name}`, start: async () => {}, stop: async () => {}, remove: async () => {} };
  };
  Docker.prototype.getContainer = (name) => ({
    id: name,
    stop: async () => {},
    remove: async () => {},
    async inspect() {
      if (!created.some((c) => c.name === name)) throw Object.assign(new Error('No such container'), { statusCode: 404 });
      return {
        Id: name, Name: `/${name}`, State: { Status: 'running' },
        Config: { Labels: { 'netguard.managed': 'true', 'netguard.botname': String(name).replace(/^netguard-/, '').replace(/-cloudflared$/, '') } },
      };
    },
  });
});
test.after(() => {
  Object.assign(Docker.prototype, saved);
  dockerService.setAutoTunnelServiceForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => {
  created.length = 0;
  config.botPortBindHost = '';
  fs.rmSync(process.env.BOTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });
  fs.rmSync(path.dirname(process.env.DB_PATH), { recursive: true, force: true });
});
test.afterEach(() => {
  config.botPortBindHost = '';
  dockerService.setAutoTunnelServiceForTests(null);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function installFakeCloudflare() {
  const client = {
    async findDnsRecords() { return []; },
    async findTunnelsByName() { return []; },
    async createTunnel() {
      const out = { id: TID };
      Object.defineProperty(out, 'token', { value: TOKEN, enumerable: false });
      return out;
    },
    async putIngress() {},
    async createCname() { return { id: REC }; },
    async getTunnelToken() { return TOKEN; },
    async deleteDnsRecord() { return { deleted: true }; },
    async deleteTunnel() { return { deleted: true }; },
  };
  dockerService.setAutoTunnelServiceForTests(createAutoTunnelService({ settings: SETTINGS, client, state: realState, ops: dockerService.autoTunnelOps, logger }));
}

const botContainer = (name) => created.find((c) => c.name === `netguard-${name}`);
const tunnelContainer = (name) => created.find((c) => c.name === `netguard-${name}-cloudflared`);

test('ตั้ง 127.0.0.1: บอททางธรรมดา (ไม่ติ๊ก autoTunnel) ได้ HostIp', async () => {
  config.botPortBindHost = '127.0.0.1';
  const port = await freePort();
  await dockerService.createBot({ name: 'viaplain', port });
  assert.deepEqual(botContainer('viaplain').HostConfig.PortBindings, { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] });
});

test('ตั้ง 127.0.0.1: บอททางกรอก token เอง ได้ HostIp ที่บอท และ container cloudflared ไม่มี PortBindings', async () => {
  config.botPortBindHost = '127.0.0.1';
  const port = await freePort();
  await dockerService.createBot({ name: 'viatoken', port, tunnelToken: 'manual_tunnel_token_0123456789abcdef' });
  assert.deepEqual(botContainer('viatoken').HostConfig.PortBindings, { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] });
  assert.equal(tunnelContainer('viatoken').HostConfig.PortBindings, undefined);
});

test('ตั้ง 127.0.0.1: บอททาง autoTunnel ได้ HostIp เหมือนกัน และ cloudflared ที่สร้างอัตโนมัติไม่เปิดพอร์ตโฮสต์', async () => {
  config.botPortBindHost = '127.0.0.1';
  installFakeCloudflare();
  const port = await freePort();
  const bot = await dockerService.createBot({ name: 'viaauto', port, autoTunnel: true, hostname: 'viaauto.example.com' });
  assert.equal(bot.tunnel.status, 'ok');
  assert.deepEqual(botContainer('viaauto').HostConfig.PortBindings, { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] });
  const tunnel = tunnelContainer('viaauto');
  assert.ok(tunnel, 'ต้องมี container cloudflared');
  assert.equal(tunnel.HostConfig.PortBindings, undefined);
  assert.ok(!JSON.stringify(tunnel.HostConfig).includes('HostIp'));
});

test('ลองใหม่ (retryAutoTunnel) ไม่สร้างบอทใหม่ จึงไม่มี container ของบอทเพิ่ม และ cloudflared ไม่เปิดพอร์ตโฮสต์', async () => {
  config.botPortBindHost = '127.0.0.1';
  installFakeCloudflare();
  const port = await freePort();
  await dockerService.createBot({ name: 'retried', port });
  assert.equal(created.filter((c) => c.name === 'netguard-retried').length, 1);
  await dockerService.retryAutoTunnel('retried', 'retried.example.com');
  assert.equal(created.filter((c) => c.name === 'netguard-retried').length, 1);
  assert.equal(tunnelContainer('retried').HostConfig.PortBindings, undefined);
});

test('ไม่ตั้งค่า: ทั้งสามทางได้ PortBindings เดิมเป๊ะ (ไม่มี HostIp)', async () => {
  installFakeCloudflare();
  const p1 = await freePort();
  await dockerService.createBot({ name: 'unset1', port: p1 });
  const p2 = await freePort();
  await dockerService.createBot({ name: 'unset2', port: p2, tunnelToken: 'manual_tunnel_token_0123456789abcdef' });
  const p3 = await freePort();
  await dockerService.createBot({ name: 'unset3', port: p3, autoTunnel: true, hostname: 'unset3.example.com' });
  for (const [name, port] of [['unset1', p1], ['unset2', p2], ['unset3', p3]]) {
    assert.deepEqual(botContainer(name).HostConfig.PortBindings, { '3000/tcp': [{ HostPort: String(port) }] }, name);
  }
});

test('ค่าที่ตั้งไม่รั่วเข้า Env/Labels/Cmd ของ container ใดๆ ที่ autoTunnel สร้าง', async () => {
  config.botPortBindHost = '127.0.0.1';
  installFakeCloudflare();
  await dockerService.createBot({ name: 'noleak', port: await freePort(), autoTunnel: true, hostname: 'noleak.example.com' });
  for (const c of created) {
    const rest = { ...c, HostConfig: { ...c.HostConfig, PortBindings: undefined } };
    assert.ok(!JSON.stringify(rest).includes('127.0.0.1'), c.name);
  }
});
