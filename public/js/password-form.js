// ตรวจฟอร์มเปลี่ยนรหัสผ่านฝั่ง browser — กฎต้องตรงกับ services/password.js (validateNewPassword) ฝั่ง server (มีเทสต์เทียบตัวเลข)
// เป็นแค่ความสะดวกของผู้ใช้ — server ตรวจซ้ำเสมอ
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;

function isSingleRepeatedChar(str) {
  const chars = Array.from(str);
  return chars.length > 1 && chars.every((c) => c === chars[0]);
}

// คืน null ถ้าผ่าน หรือข้อความที่แสดงให้ผู้ใช้
function validatePasswordForm({ current, next, confirm }) {
  if (!current) return 'กรอกรหัสผ่านเดิม';
  if (!next) return 'กรอกรหัสผ่านใหม่';
  if (next.length < PASSWORD_MIN_LENGTH) return `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`;
  if (next.length > PASSWORD_MAX_LENGTH) return `รหัสผ่านใหม่ยาวเกิน ${PASSWORD_MAX_LENGTH} ตัวอักษร`;
  if (isSingleRepeatedChar(next)) return 'รหัสผ่านใหม่ต้องไม่ใช่ตัวอักษรตัวเดียวซ้ำกันทั้งสาย';
  if (next === current) return 'รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม';
  if (next !== confirm) return 'รหัสผ่านใหม่สองช่องไม่ตรงกัน';
  return null;
}
