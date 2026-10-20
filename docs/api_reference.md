# API Reference — FlowUltraTech Backend

อัปเดตล่าสุด: 2026-10-20 · เวอร์ชัน backend: 1.0.0 (`package.json`) · เวอร์ชันแอป client: 1.7.0

อ้างอิงจากโค้ด: [src/app.ts](../src/app.ts), [src/routes/](../src/routes/), [src/controllers/adminController.ts](../src/controllers/adminController.ts), [src/middlewares/auth.ts](../src/middlewares/auth.ts), [src/services/socketHub.ts](../src/services/socketHub.ts)

## สัญลักษณ์ระดับสิทธิ์

| ป้าย | ความหมาย | middleware |
| --- | --- | --- |
| Public | ไม่ต้องล็อกอิน | – |
| JWT | ต้องมี access token | [`authenticateToken`](../src/middlewares/auth.ts#L32) |
| JWT+Lease | JWT + header `X-Instance-Lease` ของจอที่ยัง active | [`verifyActiveLease`](../src/middlewares/auth.ts#L63) |
| Admin | role `admin`/`superadmin` หรือ `isSystemRoot` | [`requireAdmin`](../src/middlewares/auth.ts#L193) |
| Superadmin | role `superadmin` หรือ `isSystemRoot` | [`requireSuperAdmin`](../src/middlewares/auth.ts#L236) |

**การส่ง access token** (`authenticateToken`): ลำดับความสำคัญ `Authorization: Bearer <token>` → query `?token=` → cookie `flow_token` ตรวจแบบ HS256 อย่างเดียว ไม่ตรวจ `status`/วันหมดอายุของผู้ใช้ และไม่มี revocation list (`jti` ถูกออกแต่ไม่ถูกใช้ตรวจ) ข้อผิดพลาดมาตรฐาน: `401 {error:"Invalid token"}` (ไม่มี token), `401 {error:"Token expired"}` (verify ล้มเหลว), `400 {error:"Invalid user ID format"}`

รูปแบบ error ทั่วไป: `{ "error": "..." }` (บางจุดใช้ `message`) ส่วน 404 ท้ายสุด `{error:"Not found"}` และ 500 จาก errorHandler `{message:"An unexpected server error occurred."}`

## 1. Public / Static (กำหนดใน app.ts)

| Method | Path | สิทธิ์ | หน้าที่ |
| --- | --- | --- | --- |
| GET | `/` | Public | ถ้า client รับ HTML ส่ง `public/index.html` ไม่งั้น JSON `{service:"captcha-service", status:"ok", version:"2.0.0"}` |
| GET | `/download`, `/landing` | Public | ส่ง landing page (ไม่มีไฟล์ → redirect `/`) |
| GET | `/health` | Public | `{status:"healthy", timestamp}` |
| GET | `/public/*` | Public | static จาก `public/` |
| GET | `/storage/*` | Public | static จาก `storage/` ทั้งโฟลเดอร์ (รวม `storage/captchas/` — ดู security note ใน operations_and_backoffice.md) |
| GET | `/storage/releases/:filename` | Public | ดาวน์โหลดตัวติดตั้ง `.exe` (ใช้ `path.basename`, 404 `{error:"Release file not found"}`) |
| GET | `/backoffice`, `/backoffice/*`, `/admin`, `/admin/*` | Public | SPA ของ Backoffice (ดู [backoffice.ts](../src/routes/backoffice.ts)); ไม่มี dist → 503 HTML |

## 2. App Release (public) — `AdminController`

| Method | Path | สิทธิ์ | หน้าที่ / ผลลัพธ์สำคัญ |
| --- | --- | --- | --- |
| GET | `/api/v1/app/latest-release`, `/app/latest-release` | Public | `{success, release}` — `AppRelease` ที่ `isLatest:true` ล่าสุด; ถ้าไม่มีใน DB สแกน `storage/releases/*.exe` เลือก semver สูงสุด; สุดท้าย fallback เป็นข้อมูล v1.0.0 ที่ฝังในโค้ด (`downloadsCount` ปลอม 168) |
| GET | `/api/v1/app/releases`, `/app/releases`, `/api/v1/app/versions` | Public | `{success, latestVersion, minRequiredVersion, totalCount, releases[]}` กรองเฉพาะ `minRequiredVersion ≤ version ≤ latest`, เรียง semver ลดหลั่น, `downloadUrl` ถูกเขียนเป็น `/api/v1/app/download?version=` |
| GET | `/api/v1/app/download`, `/download/installer`, `/download/setup` | Public | query `version`/`v` (ตัด `v` นำหน้า) → ส่งไฟล์ `.exe` (ค้น DB → ชื่อไฟล์ → latest → ไฟล์ semver สูงสุด) และ `$inc downloadsCount` |

## 3. Auth — `authRouter` (mount ที่ `/api/v1/auth` และ alias root `/login` ฯลฯ)

โค้ด: [src/routes/auth.ts](../src/routes/auth.ts)

| Method | Path | สิทธิ์ | Request สำคัญ | Response / พฤติกรรม |
| --- | --- | --- | --- | --- |
| POST | `/login` | Public + `loginLimiter` (25 ครั้ง/5 นาที/IP) | `username`, `password`, `hwid?`, `deviceName?`, `appVersion?` | 200: `userId, username, role, isSystemRoot, accessToken, refreshToken, expiredTime(ms), license, maxTiktokAccounts, deviceLimit, setting/settings, version:1, appVersion{latestVersion,minRequiredVersion,downloadUrl,title,description,isMandatory}` + cookie `flow_token` (httpOnly, sameSite lax) · 400 `ไม่พบชื่อนี้ในระบบ` (ทั้งกรณีไม่ส่ง field และไม่พบ user) / `รหัสผ่านไม่ถูกต้อง` · 403 `บัญชีถูกระงับการใช้งาน` (status suspended) · 403 `{error:"LICENSE_EXPIRED", isExpired:true, message}` (`license.expiredAt` ผ่านแล้ว ยกเว้น root) |
| POST | `/refreshToken` | Public | `refreshToken` (body) หรือ `Authorization: Bearer <refresh>` | หา `RefreshToken` จาก SHA-256 ของ token ที่ `expiresAt > now`; user ต้อง `status=active`; ออก access token ใหม่ และ **ต่ออายุ refresh แบบ sliding 30 วัน โดยคง token เดิม ไม่หมุนเปลี่ยน**; 200 `{accessToken, refreshToken}` · 403 `Token expired` / `User inactive or not found` |
| GET | `/me` | JWT | – | `userId, username, email, role, isSystemRoot, status, license, maxTiktokAccounts, deviceLimit, captchaQuota, setting(s), expiredTime, appVersion`; ถ้า license หมดอายุ (ไม่ใช่ root) → ตั้ง `status="expired"` แล้วตอบ 403 `LICENSE_EXPIRED` |
| GET | `/settings` | JWT | – | `{settings}` (รวม `telegramBotToken`, `telegramChatId`, `autoSolveDelaySeconds`, `captchaSoundVolume`, `autoSaveCaptchaImage`, `rules`) |
| PUT | `/settings` | JWT | `settings{...}` หรือ field ตรง ๆ | อัปเดตเฉพาะ field ที่ส่งมา (`rules` ต้องเป็น array) → `{success, message, settings}` |
| POST | `/logout` | Public | `refreshToken` (body/Bearer) | ลบ `RefreshToken` ที่ตรง hash, ล้าง cookie `flow_token`, ตอบ `{message:"Logout success"}` เสมอ (access token เดิมยังใช้ได้จนหมดอายุ) |

อายุ token: access **24 ชั่วโมง** (ผู้ใช้ทั่วไป) / **30 วัน** (root, admin, superadmin); refresh 30 วัน (sliding) ข้อมูลใน payload access token: `id(userId), username, role, isSystemRoot, t:"a", jti`

## 4. Slots — `/api/v1/slots` (JWT ทุกตัว)

โค้ด: [src/routes/slots.ts](../src/routes/slots.ts) · `LEASE_TTL_MS` = 10 นาที ([L12](../src/routes/slots.ts#L12))

| Method | Path | Request | Response / พฤติกรรม |
| --- | --- | --- | --- |
| POST | `/acquire` | `profileFolderName` (จำเป็น), `hwid?` | ตรวจ user `status=active` และ license ไม่หมดอายุ → นับ lease อื่นของ user ที่ยังไม่หมดอายุ (ไม่รวมโปรไฟล์เดิม) ถ้า `>= maxTiktokAccounts` (root = 9999) → 403 `เกินโควต้าบัญชีสูงสุดแล้ว (เปิดอยู่ n/m บัญชี)` + บันทึก `SecurityEvent MULTIPLE_INSTANCE_ATTEMPT` (severity medium) + push `security:alert` · สำเร็จ: upsert `ActiveLease` ตาม `(userId, profileFolderName)` ออก `leaseId = lease_<32 hex>` แล้วนับซ้ำเพื่อกัน race (เกิน → ลบ + 403) → `{success, leaseId, profileFolderName, expiresAt, ttlSeconds:600}` + emit `lease:changed (acquired)` |
| POST | `/heartbeat` | `leaseId`, `hwid?`, `profileFolderName?` | ไม่พบ lease แต่ `leaseId` ตรง regex และ user active และยังไม่เกินโควต้า → **สร้าง lease คืนอัตโนมัติ (self-heal)**; ไม่พบ → 404 `SLOT_REVOKED`; หมดอายุ → 403 `LEASE_EXPIRED`; user ไม่ active → ลบ lease + 403 `ACCOUNT_INACTIVE`; license หมดอายุ → ลบ + 403 `LICENSE_EXPIRED`; lease เกินโควต้า (เรียงตาม `createdAt` เก็บ N อันแรก) → ลบ + 403 `SLOT_REVOKED`; สำเร็จ: อัปเดต `hwid` (ไม่ปฏิเสธถ้า HWID เปลี่ยน) ต่ออายุ +10 นาที → `{success, leaseId, expiresAt, message}` |
| POST | `/release` | `leaseId` | ลบ lease ของ user นั้น → `{success, released:boolean, message}` + emit `lease:changed (released)` |
| GET | `/active` | – | `{activeLeases:[...]}` ของ user ปัจจุบัน (ยังไม่หมดอายุ) |

สถานะ/รหัสผิดพลาดที่ client ใช้แยกประเภท: `SLOT_REVOKED` (+`isRevoked`), `LEASE_EXPIRED`, `LICENSE_EXPIRED` (+`isExpired`), `ACCOUNT_INACTIVE`

## 5. Captcha — mount ที่ root และ `/api/v1` (ทั้งสองแบบใช้ได้)

โค้ด: [src/routes/captcha.ts](../src/routes/captcha.ts) · ทุก path ใต้ `/captcha` ผ่าน `captchaLimiter` (120 ครั้ง/5 นาที ต่อ userId จาก JWT, ถ้าอ่านไม่ได้ใช้ IP)

| Method | Path | สิทธิ์ | หน้าที่ |
| --- | --- | --- | --- |
| POST | `/captcha/slide`, `/api/v1/captcha/slide` | JWT+Lease + `captchaLeaseLimiter` (25 ครั้ง/5 นาที/lease) + `application/json` | แก้ slide (ONNX) |
| POST | `/captcha/symbol`, `/api/v1/captcha/symbol` | เหมือนข้างบน | แก้ symbol (Python FastSAM+DINOv2) |
| POST | `/captcha/feedback`, `/captcha/verify-result`, `/feedback`, `/verify-result` (และ prefix `/api/v1`) | JWT (ไม่ต้องมี lease) | client รายงานผลจาก TikTok: `captchaId`, `status` (`VERIFIED_SUCCESS`/`SUCCESS`/`VERIFIED` หรือ `VERIFIED_FAILED`/`REJECTED_BY_TIKTOK`/`FAILED`), `feedbackText|feedback`, `elapsedSeconds|durationTotalSec`, `attempts`, `appVersion` |

**Request ของ slide/symbol**: body `image` (base64, data URL หรือ **URL http(s)** ที่ server จะ fetch เอง, สูงสุด 5 MB), `displayWidth?`, `displayHeight?` (ใช้คำนวณ scale), `appVersion?`, `profileFolder?`; header ที่เกี่ยวข้อง `X-Instance-Lease` (บังคับ), `X-Device-Hwid`, `X-App-Version`, `X-Profile-Folder`

**ลำดับตรวจก่อนแก้** (ในรหัส `handleCaptcha`): ถอดรหัสรูป → (ไม่ใช่ root) รีเซ็ต `usedToday` ถ้าข้ามวัน **UTC** → ตรวจโควต้ารายวันรวม (`captchaQuota.usedToday >= dailyLimit` → 429 `QUOTA_EXCEEDED`) → ตรวจโควต้าต่อโปรไฟล์ **200 ครั้ง/วัน** นับจาก `CaptchaLog` (status ≠ `SOLVE_FAILED`) → 429 `PROFILE_QUOTA_EXCEEDED` → แก้ → ถ้าสำเร็จ `$inc captchaQuota.usedToday` ทันที (ไม่รอ feedback)

**Response สำเร็จ (200)**: `captchaId, status:"CALCULATED", appVersion, aiVersion, position, target_x, symbol_positions, raw_position, raw_symbol_positions, raw_target_x, hole_box, image_width, image_height, display_width, display_height, scale_x, scale_y, time` · ผลแก้ไม่ได้ → 422 `{error, _status…}` + log `SOLVE_FAILED` · รูปไม่ถูกต้อง 400/413 · lease/HWID ผิด 403 · exception 500 `{captchaId, status:"SOLVE_FAILED", message}`

ผลข้างเคียง: บันทึก `CaptchaLog` (พร้อม `imageBase64`), เขียนรูปลง `storage/captchas/`, render รูป overlay `_placed.png`, emit `captcha:status_changed`, ส่ง Telegram (รูป) ถ้าผู้ใช้ตั้ง `telegramChatId`; feedback แรกเท่านั้นที่เปลี่ยนสถานะ (ซ้ำ → ตอบ already recorded) และจะส่ง Telegram ข้อความผลลัพธ์

**ตรวจ lease** (`verifyActiveLease`): ไม่มี header → 403 (ยกเว้น root ที่ผ่านได้โดยไม่มี lease) · lease ไม่พบ/หมดอายุ → 403 + `SecurityEvent EXPIRED_LEASE_ABUSE` (medium) · lease เป็นของ user อื่น → 403 + event (high) · ส่ง HWID (header `X-Device-Hwid` หรือ body `hwid`) ไม่ตรงกับ `lease.hwid` (เมื่อ lease มี HWID จริง ไม่ใช่ `unknown-hwid`) → 403 + event (high) · lease ถูก cache 15 วินาที

## 6. Security — `/api/v1/security`

| Method | Path | สิทธิ์ | Request | หน้าที่ |
| --- | --- | --- | --- | --- |
| POST | `/event` | JWT | `eventType` (จำเป็น), `details`, `hwid`, `profileFolder`, `severity` (low/medium/high/critical, default medium) | บันทึก `SecurityEvent`, push `security:alert` ไป `admin_room`, สร้าง `AuditLog` (`SECURITY_INCIDENT`) → `{success, eventId, recordedAt}` (ไม่มี rate limit; `eventType` เป็น string อิสระ) |

## 7. Profiles — `/api/v1/profiles` (JWT ทั้ง router, ข้อมูลแยกตาม `userId`)

| Method | Path | หน้าที่ |
| --- | --- | --- |
| GET | `/` | รายการ `InstanceProfile` ของผู้ใช้ `{success,count,profiles}` |
| POST | `/` | upsert 1 โปรไฟล์ตาม `(userId, profileFolderName)`; ต้องมี `name`, `profileFolderName`; field: `clientProfileId, cdpPort(default 9221), launchMode(DirectProfile/Sandboxie), proxyId, streamerUsername, customChromiumFlags, tiktokAccount{...}, rules[]` |
| DELETE | `/:folderName` | ลบโปรไฟล์ (404 ถ้าไม่พบ) |
| POST | `/:folderName/tiktok-account` | ซิงก์ตัวตนบัญชี TikTok (`isLoggedIn, tiktokUid, displayId, nickname, avatarUrl`) |
| POST | `/sync` | batch upsert จาก `profiles[]` แล้วตอบรายการทั้งหมดของผู้ใช้ |

## 8. Proxies — `/api/v1/proxies` (JWT ทั้ง router)

| Method | Path | หน้าที่ |
| --- | --- | --- |
| GET | `/` | รายการ proxy ของผู้ใช้ (เรียงตาม `proxifierId`) — **ส่ง `password` กลับเป็น plaintext** |
| POST | `/` | upsert: ต้องมี `host`, `port`; key = `clientProxyId` ถ้ามี ไม่งั้น `proxifierId` (default 100); `protocol` เป็น `http` หรือ `socks5` |
| DELETE | `/:identifier` | ตัวเลข → ลบตาม `proxifierId`; ไม่ใช่ตัวเลข → ตาม `clientProxyId` หรือ `_id` |
| POST | `/sync` | batch upsert จาก `proxies[]` |

## 9. Admin — `/api/v1/admin` (`authenticateToken` + `requireAdmin` ทั้ง router)

โค้ด: [src/routes/admin.ts](../src/routes/admin.ts) → [`AdminController`](../src/controllers/adminController.ts)

| Method | Path | สิทธิ์เพิ่มเติม | หน้าที่ |
| --- | --- | --- | --- |
| GET | `/users` | Admin | query `page`, `limit`(≤100), `search`, `role`; คืน `users` (ไม่มี `passwordHash`) + `activeLeaseCount` + `activeDeviceCount` (จำนวน HWID ไม่ซ้ำใน refresh token ที่ยังไม่หมดอายุ), `total, page, limit, totalPages` |
| POST | `/users` | Admin (สร้าง `admin` ได้เฉพาะ superadmin; สร้าง `superadmin` ห้ามทุกกรณี) | `username, password, email?, role?, plan?, expiredAt?, deviceLimit?, maxTiktokAccounts?, dailyLimit?, settings?`; default หมดอายุ +30 วัน; `captchaQuota.dailyLimit` = `dailyLimit` หรือ `maxTiktokAccounts × 200`; ตอบ 201 `{success,user}`; audit `USER_CREATE` |
| GET | `/users/:id` | Admin | `:id` = ObjectId / userId / username → `{user, activeLeases, activeSessions(refresh tokens), profiles, proxies}` |
| PUT | `/users/:id` | `protectRoot` | แก้ `password, role, status, email, license{...}, maxTiktokAccounts, deviceLimit, addHours, addDays/extendDays, expiredAt, captchaQuota, settings`; ลดโควต้าจอ → ลบ lease ส่วนเกิน (ใหม่สุดก่อน) + `quota:reduced`; status suspended/expired → `license:kickout`; ทุกครั้ง `license:updated`; audit `USER_UPDATE` |
| POST | `/users/:id/grace-period` | Admin | `hours` (default 2, ขั้นต่ำ 1) ต่อเวลาจาก `max(expiredAt, now)` + ตั้ง `status=active` + `license:updated`; audit `USER_GRACE_PERIOD` |
| DELETE | `/users/:id` | `protectRoot` | ลบ user + refresh token + lease, `license:kickout (ACCOUNT_DELETED)`, audit `USER_DELETE` |
| POST | `/users/:id/reset-devices` | Admin | ลบ `RefreshToken` ทั้งหมดของ user (ล็อกเอาท์ทุกเครื่อง) + `license:kickout (DEVICES_RESET_BY_ADMIN)`; audit `DEVICE_RESET` |
| GET | `/leases` | Admin | lease ทั้งหมดที่ยังไม่หมดอายุ → `{leases:[... + username, role]}` |
| GET | `/online-users` | Admin | `{success, users}` จาก Socket session ในหน่วยความจำ + lease |
| DELETE | `/leases/:leaseId` | Admin | ปลด lease (ไม่ emit socket; audit `LEASE_RELEASE`) |
| GET | `/stats` | Admin | `totalUsers, activeUsers, activeLeases, activeDevices, mongoStatus, serverUptime, cacheMetrics` (cache 4 วินาที) |
| GET | `/captchas`, `/captcha-logs` | Superadmin | query `page, limit, type, userId, status, success` → `logs` พร้อม `imageUrl`, `imageWithPositionUrl`, `aiVersion` |
| GET | `/captchas/:filename/image` | Superadmin | ส่งรูป (`?overlay=true` เพื่อรูปที่วาดตำแหน่ง; สร้างสดถ้ายังไม่มี; fallback `imageBase64` ใน DB) |
| GET | `/logs` | Superadmin | audit log: query `page, limit, category, action, reverted, reversible, search` |
| POST | `/logs/:id/revert` | Superadmin | ย้อนคืนตาม `executeRevert` (ดูตารางใน operations_and_backoffice.md) |
| GET | `/cache-stats` | Superadmin | `{success, metrics}` |
| POST | `/releases/upload` | Superadmin | multipart field `installer` (≤500 MB) → `{fileName, originalName, fileSize, fileHash(sha256), detectedVersion, downloadUrl}` (ยังไม่สร้าง record) |
| POST | `/releases/broadcast` | Superadmin | body `version, fileName, downloadUrl` (จำเป็น), `minRequiredVersion, title, description, fileSize, fileHash, isMandatory` → ตั้ง release เก่าเป็น `isLatest:false`, สร้าง `AppRelease`, emit `app:update` ถึงทุก socket, audit `APP_RELEASE` |
| GET | `/releases` | Superadmin | 50 รายการล่าสุด |

`protectRoot` ([protectRoot.ts](../src/middlewares/protectRoot.ts)): ถ้าเป้าหมายเป็น root — `DELETE` → 403 + `SecurityEvent ROOT_PROTECTION_TRIGGERED (critical)`; body ที่ตั้ง `status` เป็น suspended/expired หรือ `isSystemRoot:false` → 403 + event (high) กฎ role เพิ่มเติม: admin ทั่วไปแก้/ลบ admin หรือ root ไม่ได้ และตั้ง role อื่นนอกจาก `user` ไม่ได้

## 10. Socket.io

โค้ด: [src/services/socketHub.ts](../src/services/socketHub.ts) (`initSocketHub`) · CORS `*`, `pingInterval` 10 วินาที, `pingTimeout` 5 วินาที

**Handshake**: ตรวจ JWT HS256 ครั้งเดียวตอนเชื่อมต่อ จาก `auth.token` → header `Authorization` → query `token` ส่ง `auth.clientType` (`desktop` | `backoffice`); ถูกถือเป็น backoffice ถ้า `clientType=backoffice`, referer มี `/backoffice`/`/admin` หรือ User-Agent มี `Mozilla/Chrome/Safari` ทุก socket เข้า room `user_<userId>`; admin/superadmin/root เข้า `admin_room` เพิ่ม; เฉพาะ `clientType=desktop` ที่ไม่ใช่ backoffice ถูกลงทะเบียนใน `onlineSessions`

### Client → Server

| Event | จากใคร | Payload | Ack / ผล |
| --- | --- | --- | --- |
| `slot:heartbeat` | desktop | `{leaseId, hwid?, profileFolderName?}` | ack `{success, statusCode, leaseId, expiresAt, message}` หรือ `{success:false, statusCode:404/403, error: SLOT_REVOKED/LEASE_EXPIRED/ACCOUNT_INACTIVE/LICENSE_EXPIRED, isRevoked?, isExpired?}` — logic เหมือน HTTP heartbeat (self-heal, ตรวจ user/license/โควต้า, ต่อ +10 นาที) แต่อ่าน User จาก DB ทุกครั้ง (ไม่ผ่าน cache) |
| `client:instances_report` | desktop | `{appVersion, hwid, hostname, isProgramOpen, runningCount, totalCount, instances[]}` | อัปเดต session แล้ว emit `admin:online_users_updated` (debounce 200 ms) |
| `client:instance_logs_response` | desktop | `{requestId, success, logs, fileName, ...}` | ปิด pending request และ relay ไป `admin:instance_logs_received` |
| `ping:check` | ใดก็ได้ | – | ack `{time}` |
| `admin:get_online_users` | admin | – | ack `{success, users}` (ไม่ตรวจ role ใน handler นี้) |
| `admin:fetch_instance_logs` | admin | `{targetUserId, targetSocketId?, profileFolderName?, accountName?, cdpPort?, maxLines?}` | ตรวจ role ใน handler; emit `cmd:get_instance_logs` ไปยัง socket/room เป้าหมาย; timeout 15 วินาที |

### Server → Client

| Event | ส่งไปที่ | Payload สำคัญ | ผู้ส่ง (trigger) |
| --- | --- | --- | --- |
| `connected` | socket นั้น | `{success, userId, username, role, serverTime}` | ตอน handshake สำเร็จ |
| `quota:reduced` | `user_<id>` | `{userId, newMax, revokedLeaseIds[], timestamp}` | `PUT /admin/users/:id` ลดโควต้า |
| `license:kickout` | `user_<id>` | `{userId, reason, timestamp}` | suspend/expired, ลบ user, reset-devices |
| `license:updated` | `user_<id>` | `{userId, expiredAt, maxTiktokAccounts, status, plan}` | `PUT users/:id`, `grace-period` |
| `cmd:get_instance_logs` | `user_<id>` หรือ socket | `{requestId, profileFolderName, accountName, cdpPort, maxLines}` | `admin:fetch_instance_logs` |
| `app:update` | **ทุก socket** | `{release{version, minRequiredVersion, title, description, downloadUrl, isMandatory, fileSize, fileHash, publishedAt}, timestamp}` | `POST /admin/releases/broadcast` |
| `user:quota_reduced`, `user:kickout`, `user:updated` | `admin_room` | ชุดเดียวกับ `quota:reduced`/`license:kickout`/`license:updated` | ตัวเดียวกัน |
| `lease:changed` | `admin_room` | `{action: acquired/released/revoked, lease, timestamp}` | `slots/acquire`, `slots/release`, heartbeat ที่ revoke, `updateUser` ลดโควต้า |
| `captcha:status_changed` | `admin_room` | `{action: created/verified, log, timestamp}` | `handleCaptcha`, `/captcha/feedback` |
| `security:alert` | `admin_room` | `{alert, timestamp}` | `slots/acquire` เกินโควต้า, `POST /security/event` |
| `audit:logged` | `admin_room` | `{log, timestamp}` | `recordAuditLog` |
| `admin:online_users_updated` | `admin_room` | `{users[]}` | connect/report/disconnect (debounce 200 ms) |
| `admin:instance_logs_received` | `admin_room` | payload ของ client | `client:instance_logs_response` |

## 11. Rate limit และข้อจำกัดขนาด

| ตัวจำกัด | ค่า | key | ที่ใช้ |
| --- | --- | --- | --- |
| `loginLimiter` | 25 ครั้ง / 5 นาที | IP (`trust proxy` = `TRUST_PROXY`) | `POST /login` |
| `captchaLimiter` | 120 ครั้ง / 5 นาที | userId จาก JWT (ไม่ได้ → IP) | ทุก path ใต้ `/captcha` |
| `captchaLeaseLimiter` | 25 ครั้ง / 5 นาที | `lease:<X-Instance-Lease>` (ไม่มี → IP) | `/captcha/slide`, `/captcha/symbol` |
| JSON body | 10 MB | – | `express.json` |
| รูป captcha | 5 MB | – | `MAX_IMAGE_BYTES` |
| ตัวติดตั้ง | 500 MB | – | multer ใน `admin.ts` |

ไม่มี rate limit กับ `/security/event`, `/refreshToken`, `/slots/*`, `/profiles`, `/proxies`, `/admin/*`

## ข้อสังเกต/ช่องว่าง (ยังไม่ยืนยันจากโค้ด)

- Backoffice (ที่ build อยู่ใน `backoffice/dist`) อ่าน response ของ `GET /admin/leases` จากคีย์ `activeLeases` แต่ API ส่งคีย์ `leases` และส่ง query `isReverted` ให้ `/admin/logs` ขณะที่ controller อ่าน `reverted` — ไม่ได้รันยืนยัน แต่โค้ดทั้งสองฝั่งไม่ตรงกัน (ดู operations_and_backoffice.md)
- `models/index.ts` ไม่ export `AppRelease` (controller import ตรงจากไฟล์จึงไม่กระทบ)
