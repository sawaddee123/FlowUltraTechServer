import express, { type Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  authenticateToken,
  extractBearer,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
} from "../middlewares/auth.js";
import { User, type UserDocument } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { SecurityEvent } from "../models/SecurityEvent.js";
import { AppRelease } from "../models/AppRelease.js";
import { emitSecurityAlert } from "../services/socketHub.js";

export const authRouter: Router = express.Router();

const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const getLatestAppVersionPayload = async (req: Request) => {
  try {
    const latest = await AppRelease.findOne({ isLatest: true }).sort({ publishedAt: -1 });
    if (latest) {
      const downloadUrl = latest.downloadUrl.startsWith("/")
        ? `${req.protocol}://${req.get("host")}${latest.downloadUrl}`
        : latest.downloadUrl;
      return {
        latestVersion: latest.version,
        minRequiredVersion: latest.minRequiredVersion,
        downloadUrl,
        title: latest.title,
        description: latest.description,
        isMandatory: latest.isMandatory,
      };
    }
  } catch {
    // fallback
  }
  return {
    latestVersion: "1.0.0",
    minRequiredVersion: "1.0.0",
    downloadUrl: "https://github.com/sawaddee123/TiktokStudioSandbox/releases",
  };
};

// POST /login & POST /api/v1/auth/login
const handleLogin = async (req: Request, res: Response): Promise<void> => {
  const { username, password, hwid, deviceName, appVersion } = req.body ?? {};

  if (!username || !password) {
    res.status(400).json({ error: "ไม่พบชื่อนี้ในระบบ" });
    return;
  }

  try {
    const user = (await User.findOne({
      username: String(username).toLowerCase().trim(),
    })) as UserDocument | null;

    if (!user) {
      res.status(400).json({ error: "ไม่พบชื่อนี้ในระบบ" });
      return;
    }

    let isPasswordValid = await bcrypt.compare(String(password), user.passwordHash);
    if (!isPasswordValid && user.passwordHash === password) {
      user.passwordHash = await bcrypt.hash(password, 10);
      await user.save();
      isPasswordValid = true;
    }

    if (!isPasswordValid) {
      res.status(400).json({ error: "รหัสผ่านไม่ถูกต้อง" });
      return;
    }

    if (user.status === "suspended") {
      res.status(403).json({ error: "บัญชีถูกระงับการใช้งาน" });
      return;
    }

    const now = new Date();
    if (!user.isSystemRoot && user.license?.expiredAt && now > new Date(user.license.expiredAt)) {
      res.status(403).json({
        error: "LICENSE_EXPIRED",
        isExpired: true,
        message: "บัญชีของคุณหมดอายุการใช้งานแล้ว กรุณาติดต่อแอดมินเพื่อต่ออายุ (หรือขอขยายเวลา 2 ชม.)",
      });
      return;
    }

    // Device limit check removed: users can log in from any machine, screen quota is enforced on active instances

    // Generate JWT access token (24h lifespan for stable unattended automation)
    const accessToken = jwt.sign(
      {
        id: user.userId,
        username: user.username,
        role: user.role,
        isSystemRoot: user.isSystemRoot,
        t: "a",
        jti: crypto.randomUUID(),
      },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "24h" }
    );

    // Generate Refresh token
    const refreshTokenPayload = { id: user.userId, username: user.username, t: "r" };
    const rawRefreshToken =
      crypto.randomBytes(16).toString("hex") +
      "." +
      jwt.sign(refreshTokenPayload, JWT_REFRESH_SECRET, {
        algorithm: "HS256",
        expiresIn: "30d",
      });

    const tokenHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await RefreshToken.create({
      userRef: user._id,
      userId: user.userId,
      tokenHash,
      device: {
        hwid: hwid ? String(hwid).trim() : "unknown-hwid",
        deviceName: deviceName ? String(deviceName).trim() : "Unknown Device",
        ipAddress: req.ip ?? "127.0.0.1",
        appVersion: appVersion ? String(appVersion).trim() : "1.0.0",
      },
      expiresAt,
    });

    res.json({
      userId: user.userId,
      username: user.username,
      role: user.role,
      isSystemRoot: user.isSystemRoot,
      accessToken,
      refreshToken: rawRefreshToken,
      expiredTime: user.license?.expiredAt ? new Date(user.license.expiredAt).getTime() : 0,
      license: user.license,
      maxTiktokAccounts: user.license?.maxTiktokAccounts ?? 1,
      deviceLimit: user.license?.deviceLimit ?? 1,
      setting: user.settings,
      settings: user.settings,
      version: 1,
      appVersion: await getLatestAppVersionPayload(req),
    });
  } catch (error) {
    console.error("[auth:login] Error during login:", error);
    res.status(500).json({ error: "Internal server error during login" });
  }
};

// POST /refreshToken & POST /api/v1/auth/refreshToken
const handleRefreshToken = async (req: Request, res: Response): Promise<void> => {
  const tokenFromHeader = extractBearer(req.header("Authorization"));
  const tokenFromBody = req.body?.refreshToken as string | undefined;
  const rawToken = tokenFromBody || tokenFromHeader;

  if (!rawToken) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  try {
    const hashed = hashToken(rawToken);
    const tokenRecord = await RefreshToken.findOne({
      tokenHash: hashed,
      expiresAt: { $gt: new Date() },
    });

    if (!tokenRecord) {
      res.status(403).json({ error: "Token expired" });
      return;
    }

    const user = (await User.findOne({ userId: tokenRecord.userId })) as UserDocument | null;
    if (!user || user.status !== "active") {
      res.status(403).json({ error: "User inactive or not found" });
      return;
    }

    // Generate new Access Token (24h lifespan for stable unattended automation)
    const accessToken = jwt.sign(
      {
        id: user.userId,
        username: user.username,
        role: user.role,
        isSystemRoot: user.isSystemRoot,
        t: "a",
        jti: crypto.randomUUID(),
      },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "24h" }
    );

    // Rotate Refresh Token
    const newRawRefreshToken =
      crypto.randomBytes(16).toString("hex") +
      "." +
      jwt.sign({ id: user.userId, username: user.username, t: "r" }, JWT_REFRESH_SECRET, {
        algorithm: "HS256",
        expiresIn: "30d",
      });

    tokenRecord.tokenHash = hashToken(newRawRefreshToken);
    tokenRecord.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await tokenRecord.save();

    res.json({
      accessToken,
      refreshToken: newRawRefreshToken,
    });
  } catch (error) {
    console.error("[auth:refreshToken] Error:", error);
    res.status(403).json({ error: "Token expired" });
  }
};

// GET /me & GET /api/v1/auth/me
const handleMe = async (req: Request, res: Response): Promise<void> => {
  const userId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const now = new Date();
    const isExpired = !user.isSystemRoot && user.license?.expiredAt && now > new Date(user.license.expiredAt);
    if (isExpired && user.status !== "expired") {
      user.status = "expired";
      await user.save();
    }

    if (isExpired) {
      res.status(403).json({
        error: "LICENSE_EXPIRED",
        isExpired: true,
        message: "ใบอนุญาตใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมินเพื่อต่ออายุ (หรือขอขยายเวลา 2 ชม.)",
      });
      return;
    }

    res.json({
      userId: user.userId,
      username: user.username,
      email: user.email,
      role: user.role,
      isSystemRoot: user.isSystemRoot,
      status: user.status,
      license: user.license,
      maxTiktokAccounts: user.license?.maxTiktokAccounts ?? 1,
      deviceLimit: user.license?.deviceLimit ?? 1,
      captchaQuota: user.captchaQuota,
      setting: user.settings,
      settings: user.settings,
      expiredTime: user.license?.expiredAt ? new Date(user.license.expiredAt).getTime() : 0,
      appVersion: await getLatestAppVersionPayload(req),
    });
  } catch (error) {
    console.error("[auth:me] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// GET /settings & GET /api/v1/auth/settings
const handleGetSettings = async (req: Request, res: Response): Promise<void> => {
  const userId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      settings: user.settings ?? {
        telegramBotToken: "",
        telegramChatId: "",
        autoSolveDelaySeconds: 5,
        captchaSoundVolume: 80,
        autoSaveCaptchaImage: true,
        rules: [],
      },
    });
  } catch (error) {
    console.error("[auth:getSettings] Error:", error);
    res.status(500).json({ error: "Internal server error fetching settings" });
  }
};

// PUT /settings & PUT /api/v1/auth/settings
const handleUpdateSettings = async (req: Request, res: Response): Promise<void> => {
  const userId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const payload = req.body?.settings ?? req.body ?? {};

    if (!user.settings) {
      user.settings = {
        telegramBotToken: "",
        telegramChatId: "",
        autoSolveDelaySeconds: 5,
        captchaSoundVolume: 80,
        autoSaveCaptchaImage: true,
        rules: [],
      };
    }

    if (payload.telegramBotToken !== undefined) {
      user.settings.telegramBotToken = String(payload.telegramBotToken);
    }
    if (payload.telegramChatId !== undefined) {
      user.settings.telegramChatId = String(payload.telegramChatId);
    }
    if (payload.autoSolveDelaySeconds !== undefined) {
      user.settings.autoSolveDelaySeconds = Number(payload.autoSolveDelaySeconds);
    }
    if (payload.captchaSoundVolume !== undefined) {
      user.settings.captchaSoundVolume = Number(payload.captchaSoundVolume);
    }
    if (payload.autoSaveCaptchaImage !== undefined) {
      user.settings.autoSaveCaptchaImage = Boolean(payload.autoSaveCaptchaImage);
    }
    if (payload.rules !== undefined && Array.isArray(payload.rules)) {
      user.settings.rules = payload.rules;
    }

    user.markModified("settings");
    await user.save();

    res.json({
      success: true,
      message: "Settings updated successfully",
      settings: user.settings,
    });
  } catch (error) {
    console.error("[auth:updateSettings] Error:", error);
    res.status(500).json({ error: "Internal server error updating settings" });
  }
};

// POST /logout & POST /api/v1/auth/logout
const handleLogout = async (req: Request, res: Response): Promise<void> => {
  const tokenFromHeader = extractBearer(req.header("Authorization"));
  const tokenFromBody = req.body?.refreshToken as string | undefined;
  const rawToken = tokenFromBody || tokenFromHeader;

  try {
    if (rawToken) {
      const hashed = hashToken(rawToken);
      await RefreshToken.deleteOne({ tokenHash: hashed });
    }
    res.json({ message: "Logout success" });
  } catch (error) {
    console.error("[auth:logout] Error:", error);
    res.json({ message: "Logout success" });
  }
};

// Routes on authRouter (mounted at /api/v1/auth as well as root aliases)
authRouter.post("/login", handleLogin);
authRouter.post("/refreshToken", handleRefreshToken);
authRouter.get("/me", authenticateToken, handleMe);
authRouter.get("/settings", authenticateToken, handleGetSettings);
authRouter.put("/settings", authenticateToken, handleUpdateSettings);
authRouter.post("/logout", handleLogout);
