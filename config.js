require('dotenv').config();
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT, 10) || 8080,
  managerPasswordHash: process.env.MANAGER_PASSWORD_HASH || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  botImage: 'phattadol358/netguard-ai:latest',
  // BOTS_ROOT: path as seen inside this container (for fs read/write)
  botsRoot: process.env.BOTS_ROOT || '/bots',
  // BOTS_HOST_PATH: same folder's path on the Docker host (for bind mounts,
  // since dockerode's Binds are resolved by the daemon on the host, not in here)
  botsHostPath: process.env.BOTS_HOST_PATH || '',
  botNetwork: process.env.BOT_NETWORK || 'netguard-net',
  // path ของ SQLite DB ภายใน container — mount เป็น named volume แยกจาก /bots
  // (ดูเหตุผลใน CLAUDE.md หัวข้อ "เฟส 5")
  dbPath: process.env.DB_PATH || '/app/data/stats.db',
  // hash รหัสผ่านแบบ scrypt ที่ migrate มาจาก .env (อยู่ใน volume เดียวกับ stats.db) — ดู services/auth-store.js
  authFile: process.env.AUTH_FILE || path.join(path.dirname(process.env.DB_PATH || '/app/data/stats.db'), 'auth.json'),
  // POLLER_BOTS="test,test2": poll เฉพาะ bot ตามชื่อ (ว่าง = ทุก bot) — ไว้รัน Manager ชั่วคราวเพื่อทดสอบ
  // โดยไม่ยิง bot production; Manager จริงไม่ตั้งค่านี้
  pollerBots: (process.env.POLLER_BOTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // image ที่อนุญาตให้ระบุต่อ bot ได้ (เฉพาะ bot ทดสอบ — ดู createBot ใน services/docker.js)
  botImageRepo: 'phattadol358/netguard-ai',
};
