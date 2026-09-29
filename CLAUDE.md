# NetGuard Manager

## ภาพรวม
Dashboard จัดการบอทหลายตัวบน server เดียว
- คุม container ของ image phattadol358/netguard-ai:latest
- โปรเจกต์ bot อยู่ที่ D:\Project Code\RealCode\LineBot (คนละ repo)
- 1 ลูกค้า = 1 bot container + 1 cloudflared container

## Architecture
- manager รันใน container, mount /var/run/docker.sock
- ทุก container join network netguard-net (ตั้งชื่อตายตัวใน compose)
- manager คุยกับ bot ผ่าน Docker DNS (container name) ไม่ใช่ localhost
- ไฟล์ bot: BOTS_HOST_PATH/<name>/{.env,data,logs}
- BOTS_ROOT = path ใน container (สำหรับ fs)
  BOTS_HOST_PATH = path บน host (สำหรับ bind mount)
  ต่างกันเพราะ dockerode ส่ง bind ให้ daemon บน host resolve
- ชื่อ container: netguard-<name> และ netguard-<name>-cloudflared
- Label: netguard.managed=true, netguard.botname=<name>,
  netguard.role=tunnel (เฉพาะ cloudflared)
- ไฟล์ bots/<name>/meta.json เก็บข้อมูลลูกค้า (ข้างๆ .env):
  {
    "companyName": "...", "contactName": "...", "contactPhone": "...",
    "contractEnd": "YYYY-MM-DD", "note": "...",
    "createdAt": "ISO string", "updatedAt": "ISO string"
  }
  ทุก field optional ยกเว้น createdAt, เขียนแบบ atomic (.tmp แล้ว rename)
- SQLite (better-sqlite3) เก็บสถิติ uptime/problems ย้อนหลัง — /app/data/stats.db
  mount เป็น named volume `manager-data` (ไม่ใช้ BOTS_HOST_PATH bind mount
  เพราะเป็นไฟล์ binary ของ manager เอง ไม่ต้องแก้จาก host + เลี่ยงปัญหา
  host path บน Windows + ไม่ต้องเพิ่ม env var ใหม่)
  poller.js poll ทุก bot ทุก 5 นาทีผ่าน Docker DNS (netguard-<name>:3000/stats)
  timeout 10 วิ, ใช้ Promise.allSettled ไม่ให้ bot ช้าบล็อกตัวอื่น

  schema:
    samples(bot_name, ts, state, partial, problems_*, hosts/aps/switches/cameras_total+up)
      — raw sample ทุก 5 นาที เก็บ 60 วัน (pruneOldSamples ลบเก่ากว่านั้น)
    daily(bot_name, day, samples, up_count, down_count, unknown_count,
          uptime_pct, avg_problems, max_problems) — เก็บถาวรไม่ลบ

  ความหมาย state:
    up      = /stats ตอบ 200 และ ok:true
    down    = /stats error/timeout หรือ container ไม่ running
    unknown = manager เองไม่ได้ poll (restart/downtime ของ manager)
    → uptime_pct = up / (up + down) เท่านั้น ไม่นับ unknown เป็น downtime
      เพราะ unknown เป็นความผิดของ manager ไม่ใช่ bot

  ตอน manager start: fillUnknownGaps() เติม sample unknown ย้อนหลังถ้า
  gap จาก sample ล่าสุด > 2 รอบ poll (10 นาที) จำกัด 288 แถว/bot (1 วัน)
  rollupDaily() รันตอนเที่ยงคืน (เช็คทุกชั่วโมงว่าข้ามวันหรือยัง) + ตอน
  manager start (เผื่อ miss ตอนดับ) แล้วตามด้วย pruneOldSamples()

## ความปลอดภัย
- docker.sock = สิทธิ์เทียบเท่า root บน host
- เข้าถึงเฉพาะ Tailscale VPN (100.64.0.0/10) + private LAN
- ห้ามผูก Cloudflare Tunnel เข้า manager เด็ดขาด
- guard 2 ชั้น: network range + session auth (timingSafeEqual)
- rate limit login 5 ครั้ง/15 นาที
- validate ทุก input: BOT_NAME_RE, port range, token format,
  path traversal guard ตอนลบไฟล์

## สถานะ
เฟส 1 (ccbd46e): scaffold + guard + auth + read-only API + Dashboard UI
เฟส 2 (21a0ce0): create/start/stop/restart/remove + shared network
เฟส 3 (dc208b3): cloudflared ต่อ bot + attach/detach + Tunnel column
เฟส 4: meta.json เก็บข้อมูลลูกค้าต่อ bot + คอลัมน์ลูกค้า + badge เตือนสัญญา
เฟส 5: SQLite เก็บสถิติ uptime/problems ย้อนหลัง + poller ทุก 5 นาที +
  Dashboard แสดง Uptime 30 วัน + modal กราฟ (Chart.js) เมื่อคลิกแถว bot
เฟส 6 (cc2a2fb): มาสคอต SVG + atmosphere background (grid/orbs/vignette/parallax) +
  network background แบบ cyber (canvas 2D, จุดลอย+เส้นเชื่อมจางๆ) +
  ปุ่ม "ตั้งค่า (.env)" ใน kebab menu เปิด modal แก้ .env ของ bot ได้ตรงๆ
  (LINE/Zabbix/Omada/HikCentral/Claude AI แบบ whitelist field — ดูหัวข้อ
  "การแก้ .env ผ่าน Manager" ด้านล่าง) — ตัดลิงก์ Port ที่เคยชี้ไปหน้า
  /setup ของ bot ออก (route /setup ยังอยู่ในโค้ด LineBot เหมือนเดิม
  เผื่อ bot ที่ install แบบ standalone ไม่ผ่าน Manager)

ยังไม่ทำ:
- ยังไม่ทดสอบบน Linux server จริง
- ปุ่ม "ทดสอบการเชื่อมต่อ" ต่อกลุ่มใน config modal (เฟสหน้า)

## การแก้ .env ผ่าน Manager (เฟส 6)
- services/env-config.js: FIELDS whitelist เท่านั้น (LINE/Zabbix/Omada/
  HikCentral/ANTHROPIC_API_KEY) — CLOUDFLARE_TUNNEL_TOKEN ไม่รวม จัดการ
  ผ่านปุ่ม Tunnel ที่มีอยู่แล้วแยกต่างหาก
- อ่าน (readEnvConfig): field secret คืนแค่ { set, hint: "••••"+4 ตัวท้าย }
  ห้ามคืนค่าเต็มเด็ดขาด — field ธรรมดาคืนค่าจริง
- เขียน (writeEnvConfig): กรอง \r\n ออกก่อนเสมอ (กัน env injection),
  secret ว่าง/ไม่ส่ง = ไม่แตะค่าเดิม, ส่ง null = ลบค่าตั้งใจ,
  URL field ต้องขึ้นต้น http(s):// , เขียนผ่าน setEnvValue เดิมใน
  docker.js (แก้ให้เขียนแบบ atomic .tmp+rename แล้ว) ไม่ copy โค้ด
- log ตอนเขียนเฉพาะชื่อ key ที่เปลี่ยน ห้าม log ค่าเด็ดขาด

## หลักการตัดสินใจ
- Docker เป็น source of truth — ไม่เก็บ state ซ้ำใน DB
  จะใส่ DB เมื่อต้องเก็บสถิติย้อนหลังเท่านั้น
- ข้อมูลลูกค้าใช้ meta.json ข้างๆ .env ก็พอ ไม่ต้อง DB
- ข้อมูลไม่โตตามเวลา (1 ต่อ 1 กับ bot, เปลี่ยนไม่บ่อย) → เก็บเป็นไฟล์
  ข้อมูลโตตามเวลา (log, สถิติย้อนหลัง, เหตุการณ์สะสม) → ต้องใช้ DB

## บทเรียนที่เจอมาแล้ว (อย่าพลาดซ้ำ)
- localhost ใน container ของ manager ≠ host
  → ใช้ container name ผ่าน Docker DNS
- Docker Desktop/WSL2 ไม่ enforce network isolation
  แต่ Docker Engine บน Linux enforce
  → bot ต้อง join network เดียวกับ manager
- express.static เสิร์ฟไฟล์ทะลุ auth guard ได้
  → guard route / และ /index.html แยกต่างหาก
- cookie secure flag: อย่าบังคับใน production
  เพราะ Tailscale/LAN ไม่มี TLS
- docker-compose environment ต้องใช้ ${VAR} จาก .env
  ไม่ hardcode ไม่งั้นแก้ .env แล้วไม่มีผล
- curl normalize ../ ทิ้งก่อนถึง server
  → ทดสอบ path traversal ต้องใช้ %2e%2e%2f
- อย่าใช้ taskkill /F /IM node.exe (ฆ่า process อื่นด้วย)
- ไม่มี .dockerignore มาก่อน → COPY . . ใน Dockerfile จะทับ node_modules
  ที่เพิ่ง npm install ถูกต้องสำหรับ Linux ด้วย node_modules จาก host (Windows)
  พังเงียบๆ เฉพาะตอนมี native module (เช่น better-sqlite3) — ต้องมี
  .dockerignore ที่ exclude node_modules เสมอ
- native module (better-sqlite3) require() สำเร็จได้แม้ ABI ไม่ตรง
  Node version แต่จะ segfault (exit 139) ตอนเรียกใช้งานจริง — เจอ error
  แบบนี้ให้เช็ค engines ใน package.json ของ dependency ก่อน ไม่ใช่แค่ดู
  ว่า npm install ผ่านหรือ require ผ่าน (better-sqlite3@13 ต้องการ
  Node >=22 แต่ base image เดิมเป็น node:20-alpine)
- listBots() ตรวจจับ bot จาก image ตรงกับ botImage ด้วย (ไม่ใช่แค่ label
  netguard.managed) → container อื่นที่ใช้ image เดียวกันโดยบังเอิญ
  (เช่น dev container ของโปรเจกต์ bot เอง) จะโผล่ในตาราง/ถูก poll ด้วย
  แม้ manager ไม่ได้เป็นคนสร้าง — ไม่ crash แต่ควรรู้ไว้
- rate limit login (5 ครั้ง/15 นาที) เป็น in-memory ต่อ process — ทดสอบ
  ด้วย script อัตโนมัติที่ login ซ้ำหลายรอบ (เช่น Playwright หลาย script
  แยกกัน) จะโดนบล็อกไว โดยไม่มี log อะไรขึ้น (rate limiter บล็อกก่อนถึง
  route handler) → รวม test เป็น script เดียวที่ login ครั้งเดียวแล้วใช้
  cookie เดิมทำหลายอย่างต่อ หรือ docker compose restart manager เพื่อ
  reset limiter ถ้าจำเป็นต้องทดสอบใหม่เร็วๆ
- bots/test/.env มีค่า OMADA_URL เพี้ยนมาก่อนหน้านี้แล้ว (ค่าจริงคือ
  "OMADA_URL=https://..." คือมี key ซ้อนอยู่ในค่า ไม่ใช่บั๊กจาก config
  modal) — ยังไม่ได้แก้ เพราะไม่อยู่ใน scope ของงานตอนนั้น ควรแก้ทีหลัง

## คำสั่งที่ใช้บ่อย
cd "D:\Project Code\RealCode\NetguardManager"
docker compose up -d --build
docker compose ps
docker compose logs manager --tail 30
Dashboard: http://localhost:8080 (รหัสตั้งไว้แล้วใน .env)

สร้าง password hash จริง (แทน default admin):
node scripts/gen-password.js "<รหัสผ่านที่ต้องการ>"
→ copy hash ที่ได้ไปใส่ MANAGER_PASSWORD_HASH ใน .env แล้ว docker compose up -d --build ใหม่

## วิธีทำงานที่ต้องการ
- ทำทีละเฟส ไม่ข้ามขั้น
- เจอ error ให้หยุดรายงานทันที ไม่แก้เอง
- ก่อน commit ตรวจ git check-ignore .env
- ทดสอบจริงเสมอ ไม่ใช่แค่ syntax check
- ลบ test artifacts (cookies.txt, test bot) หลังทดสอบเสร็จ
