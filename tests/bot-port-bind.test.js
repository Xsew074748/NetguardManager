// BOT_PORT_BIND_HOST: ให้พอร์ตโฮสต์ของบอทที่ Manager สร้าง bind กับ IP ที่กำหนด (เช่น 127.0.0.1) แทนทุก interface
// ค่าเริ่มต้นว่าง = พฤติกรรมเดิมเป๊ะ; ตั้งแล้วต้องเป็น IPv4 literal ที่ถูกต้อง ไม่งั้น Manager ล้มตอนสตาร์ต
// Docker จำลองด้วยการแทน method ของ dockerode prototype (ไม่แตะ docker.sock จริง) — รัน: npm test   (Node >= 22)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-bind-'));
process.env.BOTS_ROOT = path.join(root, 'bots');
process.env.BOTS_HOST_PATH = '/host/bots';
process.env.DB_PATH = path.join(root, 'data', 'stats.db');
delete process.env.BOT_PORT_BIND_HOST;
fs.mkdirSync(process.env.BOTS_ROOT, { recursive: true });

const Docker = require('dockerode');
const config = require('../config');
const { parseBindHost } = require('../services/bind-host');
const dockerService = require('../services/docker');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// ── ตัวตรวจค่า ───────────────────────────────────────────────────────────────
test('parseBindHost: ไม่ตั้ง/ว่าง = "" (พฤติกรรมเดิม)', () => {
  assert.equal(parseBindHost(undefined), '');
  assert.equal(parseBindHost(''), '');
});

test('parseBindHost: IPv4 literal ที่ถูกต้องผ่านและคืนค่าเดิมไม่แก้', () => {
  for (const ok of ['127.0.0.1', '0.0.0.0', '192.168.50.17', '10.0.0.1', '255.255.255.255']) {
    assert.equal(parseBindHost(ok), ok);
  }
});

test('parseBindHost: ค่าผิดทุกแบบโยน error ที่ระบุชื่อตัวแปร (hostname, IPv6, CIDR, มีพอร์ต, ช่องว่าง, ขึ้นบรรทัดใหม่, ตัวเลขเกิน, เลขศูนย์นำหน้า, ค่าอื่น)', () => {
  const bad = [
    'localhost', '::1', '[::1]', '127.0.0.1/8', '127.0.0.1:8080', ' 127.0.0.1', '127.0.0.1 ', ' ', '\t', '127.0.0.1\n',
    '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '127.0.0.1,0.0.0.0', '*', 'true', 'false', '0', 'yes', '127.0.0.x', '１２７.０.０.１',
  ];
  for (const value of bad) {
    assert.throws(() => parseBindHost(value), (e) => e instanceof Error && /BOT_PORT_BIND_HOST/.test(e.message), JSON.stringify(value));
  }
});

test('parseBindHost: ข้อความ error ตัดค่ายาวๆ ไม่ให้ท่วมหน้าจอ', () => {
  assert.throws(() => parseBindHost('x'.repeat(500)), (e) => e.message.length < 200);
});

// ── config.js ตอนสตาร์ต ─────────────────────────────────────────────────────────
function loadConfigIn(env) {
  const base = { ...process.env };
  delete base.BOT_PORT_BIND_HOST;
  return spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./config').botPortBindHost))"], {
    cwd: path.join(__dirname, '..'), env: { ...base, ...env }, encoding: 'utf8',
  });
}

test('config.botPortBindHost: ไม่ตั้ง = "" ; ตั้ง 127.0.0.1 = "127.0.0.1"', () => {
  assert.equal(config.botPortBindHost, '');
  const unset = loadConfigIn({});
  assert.equal(unset.status, 0);
  assert.equal(unset.stdout, '""');
  const set = loadConfigIn({ BOT_PORT_BIND_HOST: '127.0.0.1' });
  assert.equal(set.status, 0);
  assert.equal(set.stdout, '"127.0.0.1"');
  const empty = loadConfigIn({ BOT_PORT_BIND_HOST: '' });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '""');
});

test('ค่าผิด = โปรเซสล้มตั้งแต่โหลด config (exit ไม่ใช่ 0) พร้อมข้อความที่ระบุตัวแปร — ไม่ถอยไปใช้ทุก interface เงียบๆ', () => {
  for (const value of ['localhost', '127.0.0.1/8', ' 127.0.0.1', '::1', '999.1.1.1']) {
    const r = loadConfigIn({ BOT_PORT_BIND_HOST: value });
    assert.notEqual(r.status, 0, JSON.stringify(value));
    assert.match(r.stderr, /BOT_PORT_BIND_HOST/, JSON.stringify(value));
    assert.equal(r.stdout, '');
  }
});

// ── createBot ───────────────────────────────────────────────────────────────
const created = [];
const saved = {};
for (const key of ['getNetwork', 'listContainers', 'getImage', 'createContainer', 'getContainer']) saved[key] = Docker.prototype[key];
test.before(() => {
  Docker.prototype.getNetwork = () => ({ inspect: async () => ({}) });
  Docker.prototype.listContainers = async () => [];
  Docker.prototype.getImage = () => ({ inspect: async () => ({}) });
  Docker.prototype.createContainer = async (opts) => {
    created.push(opts);
    return { id: `id-${opts.name}`, start: async () => {}, remove: async () => {} };
  };
});
test.after(() => { Object.assign(Docker.prototype, saved); });
test.beforeEach(() => { created.length = 0; config.botPortBindHost = ''; });
test.afterEach(() => { config.botPortBindHost = ''; });

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('ไม่ตั้งค่า: PortBindings เหมือนเดิมเป๊ะ (ไม่มี key HostIp)', async () => {
  const port = await freePort();
  await dockerService.createBot({ name: 'plain', port });
  assert.deepEqual(created[0].HostConfig.PortBindings, { '3000/tcp': [{ HostPort: String(port) }] });
  assert.ok(!('HostIp' in created[0].HostConfig.PortBindings['3000/tcp'][0]));
});

test('ตั้ง 127.0.0.1: ใส่ HostIp ใน PortBindings; ส่วนอื่นของ HostConfig/ExposedPorts/Labels/Binds เหมือนเดิมทุกอย่าง', async () => {
  const port = await freePort();
  await dockerService.createBot({ name: 'plain', port });
  const baseline = JSON.parse(JSON.stringify(created[0]));

  created.length = 0;
  config.botPortBindHost = '127.0.0.1';
  await dockerService.createBot({ name: 'plain2', port: await freePort() });
  const bound = JSON.parse(JSON.stringify(created[0]));
  assert.deepEqual(bound.HostConfig.PortBindings['3000/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(bound.HostConfig.PortBindings['3000/tcp'][0].HostPort) }]);

  // ตัด PortBindings/ชื่อ/พอร์ตที่ต่างโดยธรรมชาติ แล้วที่เหลือต้องเท่ากัน
  const strip = (o, name) => {
    const c = JSON.parse(JSON.stringify(o));
    delete c.HostConfig.PortBindings;
    c.name = 'X';
    c.Labels['netguard.botname'] = 'X';
    c.HostConfig.Binds = c.HostConfig.Binds.map((b) => b.replace(`/${name}/`, '/X/'));
    return c;
  };
  assert.deepEqual(strip(bound, 'plain2'), strip(baseline, 'plain'));
});

test('ตั้งค่าแล้ว container cloudflared (ทางกรอก token เอง) ไม่ถูกกระทบ — ไม่มี PortBindings เลย', async () => {
  config.botPortBindHost = '127.0.0.1';
  await dockerService.createBot({ name: 'withtunnel', port: await freePort(), tunnelToken: 'manual_tunnel_token_0123456789abcdef' });
  const tunnel = created.find((c) => c.name === 'netguard-withtunnel-cloudflared');
  assert.ok(tunnel);
  assert.equal(tunnel.HostConfig.PortBindings, undefined);
  assert.ok(!JSON.stringify(tunnel).includes('127.0.0.1'));
});

test('0.0.0.0 ที่ตั้งชัดเจน = bind ทุก interface อย่างตั้งใจ (HostIp ถูกส่ง)', async () => {
  config.botPortBindHost = '0.0.0.0';
  await dockerService.createBot({ name: 'allif', port: await freePort() });
  assert.equal(created[0].HostConfig.PortBindings['3000/tcp'][0].HostIp, '0.0.0.0');
});

test('listBots ยังหาพอร์ตโฮสต์เจอเมื่อ Docker รายงาน IP เป็น 127.0.0.1 (ไม่กระทบตารางบอท/poller)', async () => {
  Docker.prototype.listContainers = async () => [{
    Id: 'a1', Names: ['/netguard-shop'], State: 'running', Status: 'Up 1 hour', Created: 1700000000,
    Labels: { 'netguard.managed': 'true', 'netguard.botname': 'shop' },
    Ports: [{ IP: '127.0.0.1', PrivatePort: 3000, PublicPort: 3101, Type: 'tcp' }],
  }];
  Docker.prototype.getContainer = () => ({
    inspect: async () => ({ State: { Health: { Status: 'healthy' } } }),
  });
  const bots = await dockerService.listBots();
  assert.equal(bots[0].port, 3101);
});

test('เอกสาร: CLAUDE.md ระบุให้ตั้ง BOT_PORT_BIND_HOST=127.0.0.1 ใน compose ของ Manager ตอน deploy', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.match(doc, /BOT_PORT_BIND_HOST=127\.0\.0\.1/);
  assert.match(doc, /compose/i);
  assert.match(doc, /recreate|สร้างใหม่/);
});
