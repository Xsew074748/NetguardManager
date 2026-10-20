// BOT_PORT_BIND_HOST — IP ที่ใช้ bind พอร์ตโฮสต์ของบอทที่ Manager สร้าง (HostIp ของ Docker)
// ว่าง = ไม่ระบุ (พฤติกรรมเดิม: ทุก interface); ตั้งแล้วต้องเป็น IPv4 literal ที่ถูกต้องเท่านั้น
// ค่าผิดต้องโยน error (config.js โหลดไม่ผ่าน → Manager ล้มตอนสตาร์ต) ไม่ถอยไปเปิดทุก interface แบบเงียบๆ
const net = require('net');

function parseBindHost(value) {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string' && net.isIPv4(value)) return value;
  throw new Error(`BOT_PORT_BIND_HOST must be empty or a valid IPv4 address such as 127.0.0.1 (got ${JSON.stringify(String(value).slice(0, 40))})`);
}

module.exports = { parseBindHost };
