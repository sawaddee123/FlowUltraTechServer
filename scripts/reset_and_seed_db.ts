import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "../src/config/db.js";
import {
  User,
  AuditLog,
  CaptchaLog,
  ActiveLease,
  RefreshToken,
  SecurityEvent,
  InstanceProfile,
} from "../src/models/index.js";
import { env } from "../src/config/env.js";

async function main() {
  console.log("==================================================");
  console.log("DATABASE RESET & 10 TEST USERS SEEDING SCRIPT");
  console.log("==================================================");

  await connectDb();

  console.log("\n[1/3] Clearing all collections...");
  const delUsers = await User.deleteMany({});
  const delAudit = await AuditLog.deleteMany({});
  const delCaptcha = await CaptchaLog.deleteMany({});
  const delLeases = await ActiveLease.deleteMany({});
  const delTokens = await RefreshToken.deleteMany({});
  const delEvents = await SecurityEvent.deleteMany({});
  const delProfiles = await InstanceProfile.deleteMany({});

  console.log(` - Cleared Users: ${delUsers.deletedCount}`);
  console.log(` - Cleared Audit Logs: ${delAudit.deletedCount}`);
  console.log(` - Cleared Captcha Logs: ${delCaptcha.deletedCount}`);
  console.log(` - Cleared Active Leases: ${delLeases.deletedCount}`);
  console.log(` - Cleared Refresh Tokens: ${delTokens.deletedCount}`);
  console.log(` - Cleared Security Events: ${delEvents.deletedCount}`);
  console.log(` - Cleared Instance Profiles: ${delProfiles.deletedCount}`);

  console.log("\n[2/3] Seeding Root Superadmin...");
  const rootUsername = (env.ROOT_USERNAME || "root").trim().toLowerCase();
  const rootPassword = env.ROOT_PASSWORD || "!WFXU#v1aO7338+";
  const rootPassHash = await bcrypt.hash(rootPassword, 10);

  const rootUser = await User.create({
    userId: 1000000,
    username: rootUsername,
    passwordHash: rootPassHash,
    role: "superadmin",
    isSystemRoot: true,
    status: "active",
    license: {
      plan: "enterprise",
      expiredAt: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000), // 10 years
      deviceLimit: 999,
      maxTiktokAccounts: 999,
    },
    captchaQuota: {
      dailyLimit: 999999,
      usedToday: 0,
      lastResetDate: new Date(),
    },
    settings: {
      telegramBotToken: "",
      telegramChatId: "",
      autoSolveDelaySeconds: 2,
      captchaSoundVolume: 80,
      autoSaveCaptchaImage: true,
    },
  });
  console.log(` ✓ Created Superadmin: '${rootUser.username}' (ID: ${rootUser.userId})`);

  console.log("\n[3/3] Seeding 10 Test Users (test1 - test10)...");
  for (let i = 1; i <= 10; i++) {
    const uname = `test${i}`;
    const upass = `test${i}`;
    const hash = await bcrypt.hash(upass, 10);

    const user = await User.create({
      userId: 1000000 + i,
      username: uname,
      passwordHash: hash,
      role: "user",
      isSystemRoot: false,
      status: "active",
      license: {
        plan: "standard",
        expiredAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        deviceLimit: 1,
        maxTiktokAccounts: 1,
      },
      captchaQuota: {
        dailyLimit: 1000,
        usedToday: 0,
        lastResetDate: new Date(),
      },
      settings: {
        telegramBotToken: "",
        telegramChatId: "",
        autoSolveDelaySeconds: 5,
        captchaSoundVolume: 80,
        autoSaveCaptchaImage: true,
      },
    });
    console.log(` ✓ Created User [${i}/10]: '${user.username}' / pass: '${upass}' (Quota: 1 account, 1 device)`);
  }

  // Record initial system audit log
  await AuditLog.create({
    logId: crypto.randomUUID(),
    timestamp: new Date(),
    actor: {
      userId: 1000000,
      username: "root",
      role: "superadmin",
      ipAddress: "127.0.0.1",
    },
    action: "USER_CREATE",
    category: "system",
    targetId: "SYSTEM_SEED",
    targetType: "System",
    summary: "รีเซ็ตฐานข้อมูลทั้งหมด และสร้างผู้ใช้ทดสอบ 10 บัญชี (test1 - test10)",
    changes: {
      before: null,
      after: { seededUsers: 10, rootCreated: true },
    },
    isReversible: false,
    isReverted: false,
  });

  console.log("\n==================================================");
  console.log("DATABASE RESET AND SEEDING COMPLETED SUCCESSFULLY!");
  console.log("==================================================");

  await disconnectDb();
}

main().catch((err) => {
  console.error("Fatal error during database reset and seed:", err);
  process.exit(1);
});
