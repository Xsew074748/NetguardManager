// เลิกใช้แล้ว: สคริปต์เดิมสร้าง hash SHA-256 (ไม่มี salt) และรับรหัสผ่านทาง argument
// ใช้ scripts/set-password.js แทน (scrypt, พิมพ์รหัสในเทอร์มินัล, บังคับ ≥ 12 ตัว)
console.error('gen-password.js ถูกยกเลิก — ใช้: docker exec -it netguard-manager node scripts/set-password.js');
process.exit(1);
