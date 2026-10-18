import bcrypt from "bcryptjs";
import { User, CAPTCHAS_PER_TIKTOK_ACCOUNT, type UserDocument } from "../models/User.js";

export const ensureRootUser = async (): Promise<UserDocument> => {
  const rootUsername = (process.env.ROOT_USERNAME || "root").trim().toLowerCase();
  const rootPassword = process.env.ROOT_PASSWORD || "root123456";
  const rootEmail = (process.env.ROOT_EMAIL || "root@system.local").trim().toLowerCase();

  const existingRoot = (await User.findOne({
    $or: [{ username: rootUsername }, { isSystemRoot: true }],
  })) as UserDocument | null;

  if (!existingRoot) {
    const passwordHash = await bcrypt.hash(rootPassword, 10);
    const rootUser = (await User.create({
      userId: 1000000,
      username: rootUsername,
      email: rootEmail,
      passwordHash,
      role: "superadmin",
      isSystemRoot: true,
      status: "active",
      license: {
        plan: "unlimited_root",
        expiredAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000), // 100 years
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
        autoSolveDelaySeconds: 5,
        captchaSoundVolume: 80,
        autoSaveCaptchaImage: true,
      },
    })) as UserDocument;

    console.log(`[bootstrap] Root user '${rootUsername}' created successfully`);
    return rootUser;
  }

  let needsSave = false;
  const passwordMatches = await bcrypt.compare(rootPassword, existingRoot.passwordHash);
  if (!passwordMatches) {
    existingRoot.passwordHash = await bcrypt.hash(rootPassword, 10);
    needsSave = true;
  }
  if (
    existingRoot.username !== rootUsername ||
    existingRoot.role !== "superadmin" ||
    !existingRoot.isSystemRoot ||
    existingRoot.status !== "active"
  ) {
    existingRoot.username = rootUsername;
    existingRoot.role = "superadmin";
    existingRoot.isSystemRoot = true;
    existingRoot.status = "active";
    needsSave = true;
  }
  if (!existingRoot.license) {
    existingRoot.license = {
      plan: "unlimited_root",
      expiredAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
      deviceLimit: 999,
      maxTiktokAccounts: 999,
    };
    needsSave = true;
  } else if (existingRoot.license.maxTiktokAccounts !== 999 || existingRoot.license.deviceLimit !== 999) {
    existingRoot.license.maxTiktokAccounts = 999;
    existingRoot.license.deviceLimit = 999;
    needsSave = true;
  }

  if (needsSave) {
    await existingRoot.save();
    console.log(`[bootstrap] Root user '${rootUsername}' synchronized`);
  } else {
    console.log(`[bootstrap] Root user '${rootUsername}' verified`);
  }
  return existingRoot;
};

export const ensureTestUser = async (): Promise<void> => {
  if (process.env.ENABLE_TEST_USER !== "true") {
    return;
  }

  const testUser = await User.findOne({ username: "test" });
  if (!testUser) {
    const passwordHash = await bcrypt.hash("test", 10);
    await User.create({
      userId: 1000001,
      username: "test",
      email: "test@example.com",
      passwordHash,
      role: "user",
      isSystemRoot: false,
      status: "active",
      license: {
        plan: "standard",
        expiredAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        deviceLimit: 5,
        maxTiktokAccounts: 10,
      },
      captchaQuota: {
        dailyLimit: 10 * CAPTCHAS_PER_TIKTOK_ACCOUNT,
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
    console.log("[bootstrap] Default test user 'test' seeded successfully");
  }
};
