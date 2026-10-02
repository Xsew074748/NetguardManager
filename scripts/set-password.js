// ตั้ง/เปลี่ยนรหัสผ่าน Manager — พิมพ์ในเทอร์มินัลเองเท่านั้น (ไม่รับรหัสผ่านจาก argument/pipe กันค้างใน history/ps)
//   docker exec -it netguard-manager node scripts/set-password.js
// เขียน hash แบบ scrypt ลง auth.json (volume manager-data) ไม่แตะ .env; session เก่าทั้งหมดใช้ไม่ได้ภายใน ~5 วินาที
// ถ้าลืมรหัส/ไฟล์เสีย: ลบ auth.json แล้วจะกลับไปใช้ MANAGER_PASSWORD_HASH ใน .env (docker exec netguard-manager rm /app/data/auth.json)
const readline = require('readline');
const password = require('../services/password');
const authStore = require('../services/auth-store');

if (process.argv.length > 2) {
  console.error('ไม่รับรหัสผ่านทาง argument (จะค้างใน shell history) — รันโดยไม่มี argument แล้วพิมพ์ในเทอร์มินัล');
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('ต้องรันในเทอร์มินัลแบบโต้ตอบ เช่น: docker exec -it netguard-manager node scripts/set-password.js');
  process.exit(2);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {}; // ไม่ echo ตัวอักษรที่พิมพ์
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const first = await askHidden(`รหัสผ่านใหม่ (อย่างน้อย ${password.MIN_PASSWORD_LENGTH} ตัวอักษร): `);
  const problem = password.validateNewPassword(first);
  if (problem) { console.error(problem); process.exit(1); }
  const second = await askHidden('พิมพ์รหัสผ่านใหม่อีกครั้ง: ');
  if (first !== second) { console.error('รหัสผ่านสองครั้งไม่ตรงกัน — ไม่มีการเปลี่ยนแปลง'); process.exit(1); }

  const hash = await password.hashPassword(first);
  const ok = authStore.save({ hash, weak: false, migratedFromLegacy: false, invalidateSessions: true });
  if (!ok) { console.error('เขียน auth.json ไม่สำเร็จ — ไม่มีการเปลี่ยนแปลง'); process.exit(1); }
  console.log('เปลี่ยนรหัสผ่านแล้ว — session เดิมทั้งหมดจะหมดอายุภายในไม่กี่วินาที ต้อง login ใหม่');
})().catch((err) => { console.error('ผิดพลาด:', err.message); process.exit(1); });
