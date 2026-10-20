import express, { type Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { authenticateToken, verifyActiveLease, checkIsJson, JWT_SECRET } from "../middlewares/auth.js";
import { decodeBase64Image, resolveImageInput, safeUnlink, writeTempImage } from "../utils/image.js";
import { renderOverlayOnImage } from "../utils/imageOverlay.js";
import sharp from "sharp";
import { findPosition, findPositionDetails } from "../ml/slide.js";
import { findSameSymbolPosition } from "../ml/symbol.js";
import { CaptchaLog, type CaptchaStatus } from "../models/CaptchaLog.js";
import { User, CAPTCHAS_PER_TIKTOK_ACCOUNT } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { fingerprint, lookup, rememberSolve, markReused, confirmSolve, evictForCaptcha } from "../services/captchaCache.js";
import { emitCaptchaLogUpdate } from "../services/socketHub.js";
import { sendTelegramMessage, sendTelegramPhoto } from "../services/telegramService.js";

import crypto from "node:crypto";
import fs from "node:fs/promises";

const ROOT_DIR = process.cwd();
const STORAGE_CAPTCHAS_DIR = path.join(ROOT_DIR, "storage", "captchas");

export const cleanupOldCaptchas = async (maxAgeDays: number = 7): Promise<number> => {
  try {
    const files = await fs.readdir(STORAGE_CAPTCHAS_DIR);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    for (const file of files) {
      const filePath = path.join(STORAGE_CAPTCHAS_DIR, file);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath);
          deletedCount++;
        }
      } catch {}
    }
    return deletedCount;
  } catch {
    return 0;
  }
};

export const ensureImageDirs = async (): Promise<void> => {
  try {
    await fs.mkdir(STORAGE_CAPTCHAS_DIR, { recursive: true });
    // Run background cleanup for expired captchas
    void cleanupOldCaptchas().then((count) => {
      if (count > 0) console.log(`[captcha] Purged ${count} old captcha images`);
    });
  } catch (err) {
    console.error("[captcha] Failed to ensure image directories:", err);
  }
};

const captchaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: { error: "Too many captcha requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const raw = (req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (raw) {
      try {
        const decoded = jwt.verify(raw, JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
        if (decoded.id !== undefined && decoded.id !== null) {
          return String(decoded.id);
        }
      } catch {
        // fall through to IP-based key
      }
    }
    return req.ip ?? req.socket?.remoteAddress ?? "unknown";
  },
});

const captchaLeaseLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 25,
  message: { error: "คำขอแก้ Captcha ของจอนี้ถี่เกินกำหนด กรุณารอสักครู่" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const leaseHeader = req.header("X-Instance-Lease") || req.header("x-instance-lease");
    const leaseId = Array.isArray(leaseHeader) ? leaseHeader[0] : leaseHeader;
    if (leaseId && leaseId.trim()) {
      return `lease:${leaseId.trim()}`;
    }
    return req.ip ?? req.socket?.remoteAddress ?? "unknown";
  },
});

type CaptchaKind = "slide" | "symbol";

const solve = async (kind: CaptchaKind, imageInput: string | Buffer): Promise<unknown> => {
  const start = Date.now();
  if (kind === "slide") {
    const details = await findPositionDetails(imageInput);
    if (!details || (details.slideX === 0 && details.centerY === 0)) {
      return { error: "Invalid slide position", position: [0, 0], _status: 422 };
    }
    return {
      position: [details.slideX, details.centerY],
      slide_x: details.slideX,
      hole_center_x: details.centerX,
      hole_box: {
        x1: details.x1,
        y1: details.y1,
        x2: details.x2,
        y2: details.y2,
        width: details.width,
        height: details.height,
      },
      confidence: details.conf,
      time: (Date.now() - start) / 1000,
    };
  }
  // symbol
  const positions = await findSameSymbolPosition(imageInput);
  if (
    positions[0][0] === 0 &&
    positions[0][1] === 0 &&
    positions[1][0] === 0 &&
    positions[1][1] === 0
  ) {
    return { error: "Invalid symbol positions", symbol_positions: positions, _status: 422 };
  }
  return { symbol_positions: positions, time: (Date.now() - start) / 1000 };
};

const handleCaptcha = (kind: CaptchaKind) => async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const decoded = await resolveImageInput(body.image);
  if (!decoded.ok) {
    res.status(decoded.status).json({ message: decoded.message });
    return;
  }

  let origWidth = 0;
  let origHeight = 0;
  try {
    const meta = await sharp(decoded.buffer).metadata();
    origWidth = meta.width ?? 0;
    origHeight = meta.height ?? 0;
  } catch (mErr) {
    console.warn("[captcha] Could not read image metadata:", mErr);
  }

  const numDisplayWidth = typeof body.displayWidth === "number" ? body.displayWidth : Number(body.displayWidth) || 0;
  const numDisplayHeight = typeof body.displayHeight === "number" ? body.displayHeight : Number(body.displayHeight) || 0;
  const scaleX = (numDisplayWidth > 0 && origWidth > 0) ? numDisplayWidth / origWidth : 1;
  const scaleY = (numDisplayHeight > 0 && origHeight > 0) ? numDisplayHeight / origHeight : 1;

  const userIdNum =
    typeof req.userId === "number"
      ? req.userId
      : !isNaN(Number(req.userId))
      ? Number(req.userId)
      : 0;

  const activeProfileFolder =
    req.activeLease?.profileFolderName ||
    (typeof body.profileFolder === "string" && body.profileFolder.trim() ? body.profileFolder.trim() : null) ||
    req.header("X-Profile-Folder")?.trim() ||
    "Acc01";

  // Check Daily Captcha Quota (200 per TikTok account per day) & auto reset at midnight UTC
  if (!req.user?.isSystemRoot && userIdNum > 0) {
    const userDoc = await User.findOne({ userId: userIdNum });
    if (userDoc) {
      const now = new Date();
      const lastReset = new Date(userDoc.captchaQuota?.lastResetDate || now);
      const isDifferentDay =
        now.getUTCFullYear() !== lastReset.getUTCFullYear() ||
        now.getUTCMonth() !== lastReset.getUTCMonth() ||
        now.getUTCDate() !== lastReset.getUTCDate();

      const maxAccounts = Math.max(1, Number(userDoc.license?.maxTiktokAccounts) || 1);
      const expectedTotalDailyLimit = maxAccounts * CAPTCHAS_PER_TIKTOK_ACCOUNT;

      let needsSave = false;
      if (isDifferentDay) {
        userDoc.captchaQuota.usedToday = 0;
        userDoc.captchaQuota.lastResetDate = now;
        needsSave = true;
      }

      // Normalize legacy 500/1000 default quota to 200 * maxTiktokAccounts
      if (
        !userDoc.captchaQuota.dailyLimit ||
        userDoc.captchaQuota.dailyLimit === 500 ||
        userDoc.captchaQuota.dailyLimit === 1000
      ) {
        if (userDoc.captchaQuota.dailyLimit !== expectedTotalDailyLimit) {
          userDoc.captchaQuota.dailyLimit = expectedTotalDailyLimit;
          needsSave = true;
        }
      }

      if (needsSave) {
        await userDoc.save();
      }

      const effectiveDailyLimit = userDoc.captchaQuota.dailyLimit || expectedTotalDailyLimit;

      if (userDoc.captchaQuota.usedToday >= effectiveDailyLimit) {
        res.status(429).json({
          message: `โควต้าแก้ Captcha รายวันครบกำหนดแล้ว (${userDoc.captchaQuota.usedToday}/${effectiveDailyLimit} ครั้ง — ${CAPTCHAS_PER_TIKTOK_ACCOUNT} ครั้ง/บัญชี TikTok)`,
          error: "QUOTA_EXCEEDED",
          quota: userDoc.captchaQuota,
        });
        return;
      }

      // Enforce 200 solves/day per individual TikTok account (profileFolderName)
      const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const profileUsedToday = await CaptchaLog.countDocuments({
        userId: userIdNum,
        profileFolderName: activeProfileFolder,
        status: { $ne: "SOLVE_FAILED" },
        createdAt: { $gte: startOfUtcDay },
      });

      if (profileUsedToday >= CAPTCHAS_PER_TIKTOK_ACCOUNT) {
        res.status(429).json({
          message: `โควต้าแก้ Captcha ของจอ '${activeProfileFolder}' ครบ ${CAPTCHAS_PER_TIKTOK_ACCOUNT} ครั้ง/วันแล้ว (${profileUsedToday}/${CAPTCHAS_PER_TIKTOK_ACCOUNT})`,
          error: "PROFILE_QUOTA_EXCEEDED",
          profileFolderName: activeProfileFolder,
          profileUsedToday,
          profileDailyLimit: CAPTCHAS_PER_TIKTOK_ACCOUNT,
        });
        return;
      }
    }
  }

  const captchaId = crypto.randomUUID();

  const rawAppVer =
    (typeof body.appVersion === "string" ? body.appVersion : null) ||
    req.header("X-App-Version") ||
    (typeof req.query.appVersion === "string" ? req.query.appVersion : null);

  let appVersion = rawAppVer ? String(rawAppVer).trim() : undefined;

  if (!appVersion && userIdNum > 0) {
    try {
      const latestToken = await RefreshToken.findOne({ userId: userIdNum }).sort({ createdAt: -1 }).select("device.appVersion");
      if (latestToken?.device?.appVersion) {
        appVersion = latestToken.device.appVersion;
      }
    } catch {}
  }

  const aiVersion = kind === "slide" ? "ONNX YOLOv8" : "FastSAM + DINOv2";

  // Asynchronously save to persistent storage for superadmin review (non-blocking for low latency)
  const isPng = decoded.buffer[0] === 0x89 && decoded.buffer[1] === 0x50;
  const isWebp = decoded.buffer[0] === 0x52 && decoded.buffer[1] === 0x49;
  const ext = isPng ? "png" : isWebp ? "webp" : "jpg";
  const mimeType = isPng ? "image/png" : isWebp ? "image/webp" : "image/jpeg";
  const imageBase64 = `data:${mimeType};base64,${decoded.buffer.toString("base64")}`;
  const imageFilename = `${Date.now()}_${userIdNum}_${kind}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const savedImagePath = path.join(STORAGE_CAPTCHAS_DIR, imageFilename);

  void fs.writeFile(savedImagePath, decoded.buffer).catch((saveErr) => {
    console.error("[captcha] Background image save error:", saveErr);
  });

  let solveResult: unknown = null;
  let durationSec = 0;
  let initialStatus: CaptchaStatus = "CALCULATED";
  let errorMessage: string | null = null;
  const start = Date.now();

  let rawPosition: number[] | undefined = undefined;
  let rawSymbolPositions: number[][] | undefined = undefined;
  let scaledPosition: number[] | undefined = undefined;
  let scaledSymbolPositions: number[][] | undefined = undefined;
  let targetX: number | undefined = undefined;
  let holeBox: { x1: number; y1: number; x2: number; y2: number; width: number; height: number } | undefined = undefined;

  try {
    // Process image buffer directly in memory without disk read latency
    const fp = await fingerprint(decoded.buffer);
    const cached = fp ? lookup(kind, fp) : null;
    if (cached) {
      solveResult = { ...cached.answer, time: (Date.now() - start) / 1000, cache: cached.match };
      markReused(captchaId, cached.key);
      console.log(`[captcha:${kind}] cache ${cached.match} hit ${captchaId}`);
    } else {
      solveResult = await solve(kind, decoded.buffer);
      const { _status: st, time: _t, ...answer } = solveResult as Record<string, unknown>;
      void _t;
      if (fp && !st && !answer.error) rememberSolve(captchaId, kind, fp, answer);
    }
    durationSec = (Date.now() - start) / 1000;
    const statusCode = (solveResult as { _status?: number })._status ?? 200;
    const { _status, ...rest } = solveResult as Record<string, unknown>;
    void _status;

    if (statusCode === 200 && !(solveResult as { error?: string }).error) {
      initialStatus = "CALCULATED";
      // Deduct quota immediately upon successful AI calculation to prevent skipping /feedback abuse
      if (userIdNum > 0) {
        await User.updateOne(
          { userId: userIdNum },
          { $inc: { "captchaQuota.usedToday": 1 } }
        );
      }
    } else {
      initialStatus = "SOLVE_FAILED";
      errorMessage = (solveResult as { error?: string }).error ?? "Solve failed";
    }

    if (kind === "slide" && solveResult && (solveResult as { hole_box?: typeof holeBox }).hole_box) {
      holeBox = (solveResult as { hole_box: typeof holeBox }).hole_box;
    }

    if (kind === "slide" && solveResult && Array.isArray((solveResult as { position?: number[] }).position)) {
      rawPosition = (solveResult as { position: number[] }).position;
      scaledPosition = [
        Math.round(rawPosition[0] * scaleX * 100) / 100,
        Math.round(rawPosition[1] * scaleY * 100) / 100,
      ];
      targetX = scaledPosition[0];
    } else if (kind === "symbol" && solveResult && Array.isArray((solveResult as { symbol_positions?: number[][] }).symbol_positions)) {
      rawSymbolPositions = (solveResult as { symbol_positions: number[][] }).symbol_positions;
      scaledSymbolPositions = rawSymbolPositions.map((pt) => [
        Math.round(pt[0] * scaleX * 100) / 100,
        Math.round(pt[1] * scaleY * 100) / 100,
      ]);
    }

    res.status(statusCode).json({
      ...rest,
      captchaId,
      status: initialStatus,
      appVersion,
      aiVersion,
      position: scaledPosition ?? rawPosition,
      target_x: targetX ?? (rawPosition ? rawPosition[0] : undefined),
      symbol_positions: scaledSymbolPositions ?? rawSymbolPositions,
      raw_position: rawPosition,
      raw_symbol_positions: rawSymbolPositions,
      raw_target_x: rawPosition ? rawPosition[0] : undefined,
      hole_box: holeBox,
      image_width: origWidth,
      image_height: origHeight,
      display_width: numDisplayWidth > 0 ? numDisplayWidth : origWidth,
      display_height: numDisplayHeight > 0 ? numDisplayHeight : origHeight,
      scale_x: scaleX,
      scale_y: scaleY,
      time: (solveResult as { time?: number })?.time ?? durationSec,
    });
  } catch (err) {
    durationSec = (Date.now() - start) / 1000;
    initialStatus = "SOLVE_FAILED";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[captcha:${kind}] error:`, err);
    res.status(500).json({ captchaId, status: "SOLVE_FAILED", message: "Captcha solver error" });
  } finally {
    // Save to CaptchaLog with full metadata, dimensions, scaling and database imageBase64
    try {
      let username = req.user?.username;
      if (!username && userIdNum > 0) {
        const u = await User.findOne({ userId: userIdNum }).select("username");
        username = u?.username;
      }

      const placedFilename = `${imageFilename.replace(/\.[^.]+$/, "")}_placed.png`;
      const placedImagePath = path.join(STORAGE_CAPTCHAS_DIR, placedFilename);

      const createdLog = await CaptchaLog.create({
        captchaId,
        userRef: req.user?._id,
        userId: userIdNum,
        username: username || "unknown",
        profileFolderName: activeProfileFolder,
        captchaType: kind,
        appVersion,
        aiVersion,
        imageFilename,
        imageWithPositionFilename: placedFilename,
        imageSize: decoded.buffer.length,
        imageBase64,
        imageWidth: origWidth,
        imageHeight: origHeight,
        displayWidth: numDisplayWidth > 0 ? numDisplayWidth : undefined,
        displayHeight: numDisplayHeight > 0 ? numDisplayHeight : undefined,
        status: initialStatus,
        result: {
          position: scaledPosition ?? rawPosition,
          targetX: targetX ?? (rawPosition ? rawPosition[0] : undefined),
          symbolPositions: scaledSymbolPositions ?? rawSymbolPositions,
          rawPosition,
          rawSymbolPositions,
          holeBox,
          scaleX,
          scaleY,
          durationSec,
          success: false, // will be true ONLY once verified by TikTok client!
          errorMessage,
        },
        clientIp: req.ip ?? req.socket.remoteAddress ?? "127.0.0.1",
      });

      emitCaptchaLogUpdate({
        action: "created",
        log: createdLog.toObject(),
      });

      // Background task: render placed position overlay image & send Telegram Photo Alert
      void (async () => {
        let photoBufferToSend = decoded.buffer;
        try {
          const placedBuffer = await renderOverlayOnImage(decoded.buffer, {
            captchaType: kind,
            status: initialStatus,
            result: {
              position: scaledPosition ?? rawPosition,
              targetX: targetX ?? (rawPosition ? rawPosition[0] : undefined),
              symbolPositions: scaledSymbolPositions ?? rawSymbolPositions,
              rawPosition,
              rawSymbolPositions,
              holeBox,
              scaleX,
              scaleY,
              success: false,
            },
            imageWidth: origWidth,
            imageHeight: origHeight,
          });

          await fs.writeFile(placedImagePath, placedBuffer);
          photoBufferToSend = placedBuffer;
        } catch (overlayErr) {
          console.error("[captcha] Background placed overlay save error:", overlayErr);
        }

        // Send Telegram Photo Notification from Server
        if (userIdNum > 0) {
          try {
            const user = await User.findOne({ userId: userIdNum }).select("username settings");
            if (user?.settings?.telegramChatId) {
              const caption =
                `🚨 <b>[TikTok LIVE Studio] ตรวจพบ CAPTCHA!</b>\n\n` +
                `• บัญชี: <b>${user.username}</b> (โปรไฟล์: ${activeProfileFolder})\n` +
                `• ประเภท: <b>${kind.toUpperCase()}</b>\n` +
                `• รหัสอ้างอิง: <code>${captchaId}</code>\n` +
                `• สถานะประมวลผล: <b>${initialStatus}</b> (${durationSec.toFixed(2)}s)\n` +
                `• เวลา: ${new Date().toLocaleString("th-TH")}`;
              await sendTelegramPhoto(
                user.settings.telegramBotToken || "",
                user.settings.telegramChatId,
                photoBufferToSend,
                caption
              );
            }
          } catch (tErr) {
            console.error("[captcha] Background Telegram photo alert error:", tErr);
          }
        }
      })();
    } catch (logErr) {
      console.error("[captcha] Error saving CaptchaLog:", logErr);
    }
  }
};

export const captchaRouter: Router = express.Router();

captchaRouter.use("/captcha", captchaLimiter);

captchaRouter.post(
  "/captcha/slide",
  authenticateToken,
  verifyActiveLease,
  captchaLeaseLimiter,
  checkIsJson,
  handleCaptcha("slide")
);

captchaRouter.post(
  "/captcha/symbol",
  authenticateToken,
  verifyActiveLease,
  captchaLeaseLimiter,
  checkIsJson,
  handleCaptcha("symbol")
);

// TikTok Real Verification Feedback API Endpoint (Requires Authentication & Ownership Check)
captchaRouter.post(
  ["/captcha/feedback", "/feedback", "/captcha/verify-result", "/verify-result"],
  authenticateToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body ?? {};
      const { captchaId, attempts } = body;
      let status = body.status;
      const feedbackText = body.feedbackText ?? body.feedback;
      const elapsedSeconds = body.elapsedSeconds ?? body.durationTotalSec;

      if (!captchaId || !status) {
        res.status(400).json({ error: "Missing required fields: captchaId, status" });
        return;
      }

      // Normalize status aliases from client
      const rawStatus = String(status).toUpperCase();
      if (rawStatus === "VERIFIED_SUCCESS" || rawStatus === "SUCCESS" || rawStatus === "VERIFIED") {
        status = "VERIFIED_SUCCESS";
      } else if (
        rawStatus === "VERIFIED_FAILED" ||
        rawStatus === "REJECTED_BY_TIKTOK" ||
        rawStatus === "FAILED"
      ) {
        status = "VERIFIED_FAILED";
      }

      const validStatuses: CaptchaStatus[] = ["VERIFIED_SUCCESS", "VERIFIED_FAILED"];
      if (!validStatuses.includes(status as CaptchaStatus)) {
        res.status(400).json({
          error: `Invalid status '${status}'. Must be one of: ${validStatuses.join(", ")} or REJECTED_BY_TIKTOK`,
        });
        return;
      }

      const log = await CaptchaLog.findOne({ captchaId });
      if (!log) {
        res.status(404).json({ error: `Captcha log not found for captchaId: ${captchaId}` });
        return;
      }

      const reqUserIdNum = typeof req.userId === "number" ? req.userId : Number(req.userId);
      const isAdminOrRoot =
        req.user?.isSystemRoot || req.user?.role === "superadmin" || req.user?.role === "admin";

      if (!isAdminOrRoot && !isNaN(reqUserIdNum) && log.userId !== reqUserIdNum) {
        res.status(403).json({ error: "Forbidden: You do not own this captcha record" });
        return;
      }

      // Idempotency guard: prevent duplicate feedback calls from spamming Telegram
      if (log.status === "VERIFIED_SUCCESS" || log.status === "VERIFIED_FAILED") {
        res.json({
          success: true,
          captchaId: log.captchaId,
          status: log.status,
          verifiedAt: log.verification?.verifiedAt,
          message: "Captcha verification already recorded",
        });
        return;
      }

      const feedbackAppVer =
        (typeof body.appVersion === "string" ? body.appVersion : null) ||
        req.header("X-App-Version");
      if (feedbackAppVer) {
        log.appVersion = String(feedbackAppVer).trim();
      }

      const isSuccess = status === "VERIFIED_SUCCESS";
      if (isSuccess) confirmSolve(String(captchaId));
      else evictForCaptcha(String(captchaId));
      log.status = status as CaptchaStatus;
      log.result.success = isSuccess;
      log.verification = {
        verifiedAt: new Date(),
        feedbackText: typeof feedbackText === "string" ? feedbackText : undefined,
        attempts: typeof attempts === "number" ? attempts : 1,
        actualDurationSec: typeof elapsedSeconds === "number" ? elapsedSeconds : undefined,
      };

      await log.save();

      emitCaptchaLogUpdate({
        action: "verified",
        log: log.toObject(),
      });

      // Send Telegram Verification Feedback from Server
      if (log.userId > 0) {
        void (async () => {
          try {
            const user = await User.findOne({ userId: log.userId }).select("username settings");
            if (user?.settings?.telegramChatId) {
              const emoji = isSuccess ? "✅" : "❌";
              const title = isSuccess
                ? "แก้ Captcha สำเร็จ (TikTok ยอมรับ)"
                : "TikTok ปฏิเสธผลการแก้ Captcha";
              const text =
                `${emoji} <b>[TikTok LIVE Studio] ${title}</b>\n\n` +
                `• บัญชี: <b>${user.username}</b> (โปรไฟล์: ${log.profileFolderName})\n` +
                `• ประเภท: <b>${log.captchaType.toUpperCase()}</b>\n` +
                `• รหัสอ้างอิง: <code>${log.captchaId}</code>\n` +
                `• เวลารวม: ${(log.verification?.actualDurationSec ?? 0).toFixed(1)}s\n` +
                (feedbackText ? `• ข้อความตอบกลับ: <i>${feedbackText}</i>\n` : "") +
                `• เวลา: ${new Date().toLocaleString("th-TH")}`;
              await sendTelegramMessage(
                user.settings.telegramBotToken || "",
                user.settings.telegramChatId,
                text
              );
            }
          } catch (tErr) {
            console.error("[captcha:feedback] Background Telegram message alert error:", tErr);
          }
        })();
      }

      res.json({
        success: true,
        captchaId: log.captchaId,
        status: log.status,
        verifiedAt: log.verification?.verifiedAt,
        message: isSuccess ? "Captcha verified successfully by TikTok" : "Captcha solve rejected by TikTok",
      });
    } catch (error) {
      console.error("[captcha:feedback] Error recording feedback:", error);
      res.status(500).json({ error: "Internal server error recording captcha feedback" });
    }
  }
);
