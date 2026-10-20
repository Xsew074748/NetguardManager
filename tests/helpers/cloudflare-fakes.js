// ตัวช่วยเทสต์: client Cloudflare จำลอง + ops ของ Docker จำลอง + logger จับข้อความ (ไม่เรียกของจริง, ไม่ใช้ token จริง)
// ไฟล์นี้อยู่ใน tests/helpers จึงไม่ถูกรันเป็นเทสต์ (glob คือ tests/*.test.js)
const { CloudflareError } = require('../../services/cloudflare');

const ACCT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TID = '11111111-2222-4333-8444-555555555555';
const TID2 = '22222222-2222-4333-8444-555555555555';
const REC = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'tunneltoken_SECRET_0123456789abcdefghij_ZZZ';
const SETTINGS = { enabled: true, accountId: ACCT, zoneId: ZONE, zoneName: 'example.com', reserved: [] };

const http = (status) => new CloudflareError(`cloudflare op: HTTP ${status}`, { op: 'op', code: 'http', status, cfCodes: [1], retryable: status >= 500 });
const timeoutErr = () => new CloudflareError('cloudflare op: timed out', { op: 'op', code: 'timeout', retryable: true });

// failAt: ชื่อเมธอด → error (หรือฟังก์ชันคืน error); leak=true ต่อท้ายข้อความ error ด้วย token (ทดสอบ scrub)
function makeFakes({ failAt = {}, tokenFromCreate = true, findTunnels = [], findRecords = [], leak = false } = {}) {
  const calls = [];
  const callArgs = {};
  const logs = [];
  const fail = (key) => {
    const f = failAt[key];
    if (!f) return;
    const err = typeof f === 'function' ? f() : f;
    if (leak) err.message += ` [${TOKEN}]`;
    throw err;
  };
  const rec = (name, ...args) => { calls.push(name); (callArgs[name] = callArgs[name] || []).push(args); };
  const client = {
    async createTunnel(name) {
      rec('createTunnel', name);
      fail('createTunnel');
      const out = { id: TID };
      Object.defineProperty(out, 'token', { value: tokenFromCreate ? TOKEN : null, enumerable: false });
      return out;
    },
    async getTunnelToken(id) { rec('getTunnelToken', id); fail('getTunnelToken'); return TOKEN; },
    async putIngress(id, body) { rec('putIngress', id, body); fail('putIngress'); },
    async createCname(body) { rec('createCname', body); fail('createCname'); return { id: REC }; },
    async findTunnelsByName(name) { rec('findTunnelsByName', name); fail('findTunnelsByName'); return findTunnels; },
    async findDnsRecords(host) { rec('findDnsRecords', host); fail('findDnsRecords'); return findRecords; },
    async deleteDnsRecord(id, o) { rec('deleteDnsRecord', id, o); fail('deleteDnsRecord'); return { deleted: true, alreadyGone: false }; },
    async deleteTunnel(id, o) { rec('deleteTunnel', id, o); fail('deleteTunnel'); return { deleted: true, alreadyGone: false }; },
  };
  const ops = {
    async writeEnvToken(bot, token) { rec('writeEnvToken', bot); fail('writeEnvToken'); },
    async startTunnelContainer(bot, token) { rec('startTunnelContainer', bot); fail('startTunnelContainer'); },
    async removeTunnelContainer(bot) { rec('removeTunnelContainer', bot); fail('removeTunnelContainer'); },
    async clearEnvToken(bot) { rec('clearEnvToken', bot); fail('clearEnvToken'); },
  };
  const logger = {
    info: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push(a.join(' ')),
  };
  return { client, ops, logger, calls, callArgs, logs };
}

module.exports = { ACCT, ZONE, TID, TID2, REC, TOKEN, SETTINGS, http, timeoutErr, makeFakes };
