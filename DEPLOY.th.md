# คู่มือ Deploy Caddiebot ขึ้น Render (ฟรี)

---

# ⚡ อัปเดตโค้ดที่ deploy ไปแล้ว (ใช้บ่อยสุด — อ่านแค่ส่วนนี้พอ)

Render ตั้งเป็นแบบ **Public Git Repository** ไม่ใช่ auto-deploy ดังนั้น push แล้วยังไม่ขึ้น
ต้องกด Deploy เองทุกครั้ง รวม 5 ขั้น ~5 นาที

### 1. อัปไฟล์ขึ้น GitHub
เปิด https://github.com/jatuponrat/caddiebot → **Add file** → **Upload files**
ลากไฟล์จากโฟลเดอร์ `Documents/Claude/Projects/Caddiebot` ทั้งหมด **ยกเว้น**
`node_modules/`, `_sync/`, `_backup_*/`, `.env`
⚠️ ลากโฟลเดอร์ `test/` ไปด้วย (GitHub เก็บ path ให้เอง) → เขียน commit message → **Commit changes**

### 2. ลบไฟล์เทสต์เก่าที่ root (ทำครั้งเดียว)
ใน repo ถ้ายังมี `engine.test.js` และ `session.test.js` อยู่ที่ root ให้ลบทิ้ง
(คลิกไฟล์ → ไอคอนถังขยะ → Commit) — ตอนนี้เทสต์อยู่ในโฟลเดอร์ `test/` ที่เดียว
ถ้าไม่ลบ `npm test` จะรันไฟล์เก่าที่ค้างและฟ้อง fail

### 3. สั่ง Deploy บน Render
https://dashboard.render.com → service **caddiebot** → ปุ่ม **Manual Deploy** ขวาบน
→ **Deploy latest commit** → รอจนสถานะเป็น **Live** (~2–3 นาที)

> ⚠️ อย่า deploy ระหว่างที่ก๊วนกำลังตีอยู่ — เกมจะกลับมาได้เพราะเก็บใน Postgres แล้ว
> แต่ระหว่างรีสตาร์ต ~30 วินาที บอทจะไม่ตอบ

### 4. เช็กว่าขึ้นจริง
เปิด https://caddiebot.onrender.com/health ต้องได้ครบ 3 อย่าง:

| ค่า | ต้องเป็น | ถ้าไม่ใช่ |
|---|---|---|
| `ok` | `true` | ดู Logs ใน Render |
| `db_connected` | `true` | `DATABASE_URL` ผิด/Supabase หยุดทำงาน → เกมจะหายทุกครั้งที่เครื่องหลับ |
| `thai_time_now` / `today_room_prefix` | ตรงกับวันเวลาไทย | ตรวจ `ROOM_CODE_TZ` |
| `uptime_min` | เลขน้อย ๆ | แปลว่าเพิ่ง deploy จริง |

### 5. ทดสอบ
พิมพ์ในกลุ่ม LINE หรือยิงจากเครื่อง:
```bash
curl -sX POST https://caddiebot.onrender.com/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"สร้างเกม 2 คน","sourceId":"test-deploy"}'
```
แล้วลอง `เข้าร่วม แซม 95 92 90` → `หลุม 1 แซม 5` ดูว่าตอบถูก จบแล้วพิมพ์ `จบเกม` เพื่อปิดห้องทดสอบ

### ทำครั้งเดียว: กันเครื่องหลับ
Render → Environment → เพิ่ม `SELF_URL` = `https://caddiebot.onrender.com` → Save
บอทจะ ping ตัวเองทุก 10 นาที (`/health` จะขึ้น `keep_alive: true`) ลดอาการเงียบกลางรอบ

---

# ติดตั้งครั้งแรก (ถ้าต้องสร้าง service ใหม่)

บอทนี้เป็น Node.js ที่ต้องรันตลอดเวลา + มี HTTPS — shared hosting (DirectAdmin/cPanel)
รันไม่ได้ เราจึงใช้ **Render** ซึ่งฟรีและให้ HTTPS มาให้อัตโนมัติ

> ⏱️ ใช้เวลาประมาณ 15–20 นาที

---

## สิ่งที่ต้องเตรียม

1. บัญชี **GitHub** (ฟรี) — ใช้เก็บโค้ด
2. บัญชี **Render** (ฟรี) — สมัครที่ render.com (ล็อกอินด้วย GitHub ได้เลย)
3. **LINE keys** 2 ตัว จาก LINE Developers Console:
   - `LINE_CHANNEL_SECRET` (แท็บ Basic settings)
   - `LINE_CHANNEL_ACCESS_TOKEN` (แท็บ Messaging API → Issue)

---

## ขั้นที่ 1 — เอาโค้ดขึ้น GitHub

สร้าง repository ว่าง ๆ บน GitHub ก่อน (เช่นชื่อ `caddiebot`) แล้วในเครื่องคุณ
เปิด Terminal ที่โฟลเดอร์โปรเจกต์ แล้วรัน:

```bash
git init
git add .
git commit -m "Caddiebot LINE webhook"
git branch -M main
git remote add origin https://github.com/<ชื่อคุณ>/caddiebot.git
git push -u origin main
```

> ไฟล์ `.env` จะไม่ถูกอัปโหลด (มี `.gitignore` กันไว้แล้ว) — ปลอดภัย คีย์ไม่หลุด

---

## ขั้นที่ 2 — Deploy บน Render

1. เข้า render.com → กด **New +** → **Blueprint**
2. เชื่อมบัญชี GitHub แล้วเลือก repo `caddiebot`
3. Render จะอ่านไฟล์ `render.yaml` ให้อัตโนมัติ → กด **Apply**

(หรือถ้าไม่ใช้ Blueprint: New + → **Web Service** → เลือก repo →
Build Command = `npm install`, Start Command = `npm start`, Health Check Path = `/health`)

---

## ขั้นที่ 3 — ใส่ค่า LINE secrets

ในหน้า service ของ Render → แท็บ **Environment** → เพิ่ม 2 ค่า:

| Key | Value |
|---|---|
| `LINE_CHANNEL_SECRET` | (จาก Basic settings) |
| `LINE_CHANNEL_ACCESS_TOKEN` | (จาก Messaging API → Issue) |

กด Save → Render จะ deploy ใหม่ให้ รอจนขึ้น **Live** แล้วคัดลอก URL ของ service
(เช่น `https://caddiebot-xxxx.onrender.com`)

> เช็คว่ารันแล้ว: เปิด `https://caddiebot-xxxx.onrender.com/health`
> ควรเห็น `{"ok":true,...}`

---

## ขั้นที่ 4 — ตั้ง Webhook ใน LINE

ที่ LINE Developers Console → channel ของคุณ → แท็บ **Messaging API**:

1. **Webhook URL** = `https://caddiebot-xxxx.onrender.com/webhook` → Update → **Verify**
   (ควรได้ Success; ถ้า timeout เพราะ Render ฟรีกำลัง "หลับ" ให้กด Verify ซ้ำอีกครั้ง)
2. เปิด **Use webhook** = ON
3. เปิด **Allow bot to join group chats** = ON ⚠️ จำเป็นสำหรับโหมดกลุ่ม
4. ไปที่ LINE Official Account Manager → ปิด **Auto-reply** และ **Greeting message**

---

## ขั้นที่ 5 — ทดสอบในกลุ่ม

1. แท็บ Messaging API → สแกน **QR code** เพิ่มบอทเป็นเพื่อน
2. สร้างกลุ่ม LINE แล้ว **เชิญบอทเข้ากลุ่ม** → บอทจะทักทายเป็นภาษาไทย
3. พิมพ์ทดสอบในกลุ่ม:
   ```
   สร้างเกม 4 คน
   เข้าร่วม ชื่อ ต้น 92,95,90
   เข้าร่วม ชื่อ บอย 80,82,84
   หลุม 1 ต้น 5 บอย 6
   ```

---

## ข้อควรรู้ (Render ฟรี)

- **หลับเมื่อว่าง ~15 นาที** — คนแรกที่ทักหลังหลับจะรอ ~30 วินาที (cold start)
  ถ้าต้องการให้ตื่นตลอด: อัปเป็น Starter plan (~$7/เดือน) หรือย้ายไป VPS
- **state เก็บใน Postgres แล้ว** (ตั้งแต่ 28 ก.ค. 2026) — เกมที่ค้างอยู่กลับมาได้หลัง redeploy
  ถ้า `/health` ขึ้น `db_connected: false` แปลว่าไม่ได้เก็บจริง ให้แก้ `DATABASE_URL` ก่อน

---

## แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุ/วิธีแก้ |
|---|---|
| Verify ไม่ผ่าน / timeout | Render กำลังหลับ → กด Verify ซ้ำ; ดู **Logs** ใน Render |
| บอทไม่ตอบในกลุ่ม | ยังไม่เปิด *Allow bot to join group chats* หรือ *Use webhook* หรือยังไม่ปิด Auto-reply |
| ตอบ error 401 (ใน Logs) | `LINE_CHANNEL_SECRET` ผิด |
| ส่งข้อความแล้วเงียบ | `LINE_CHANNEL_ACCESS_TOKEN` ผิด/หมดอายุ → Issue ใหม่ |
| เกมหายบ่อย | เช็ก `/health` → `db_connected` ต้องเป็น true และตั้ง `SELF_URL` กันหลับ |
| deploy แล้วโค้ดไม่เปลี่ยน | ลืมกด Manual Deploy → Deploy latest commit |
