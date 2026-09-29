import bcrypt from "bcryptjs";
import { User, type UserDocument } from "../models/User.js";

export const ensureRootUser = async (): Promise<UserDocument> => {
  const rootUsername = (process.env.ROOT_USERNAME || "root").trim().toLowerCase();
  const rootPassword = process.env.ROOT_PASSWORD || "root123456";
  const rootEmail = (process.env.ROOT_EMAIL || "root@system.local").trim().toLowerCase();

  const existingRoot = (await User.findOne({
    $or: [{ username: rootUsername }, { isSystemRoot: true }],
  })) as UserDocument | null;

  const passwordHash = await bcrypt.hash(rootPassword, 10);

  if (!existingRoot) {
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

  // Synchronize root user properties and password from env
  existingRoot.username = rootUsername;
  existingRoot.passwordHash = passwordHash;
  existingRoot.role = "superadmin";
  existingRoot.isSystemRoot = true;
  existingRoot.status = "active";
  if (!existingRoot.license) {
    existingRoot.license = {
      plan: "unlimited_root",
      expiredAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
      deviceLimit: 999,
      maxTiktokAccounts: 999,
    };
  } else {
    existingRoot.license.maxTiktokAccounts = 999;
    existingRoot.license.deviceLimit = 999;
  }

  await existingRoot.save();
  console.log(`[bootstrap] Root user '${rootUsername}' verified and synchronized`);
  return existingRoot;
};

export const ensureTestUser = async (): Promise<void> => {
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
    console.log("[bootstrap] Default test user 'test' seeded successfully");
  }
};
