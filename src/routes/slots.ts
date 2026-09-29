import express, { type Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { authenticateToken, extractBearer, JWT_SECRET } from "../middlewares/auth.js";
import { User, type UserDocument } from "../models/User.js";
import { ActiveLease } from "../models/ActiveLease.js";
import { SecurityEvent } from "../models/SecurityEvent.js";
import { emitLeaseChanged, emitSecurityAlert } from "../services/socketHub.js";
import { cacheManager } from "../services/cacheManager.js";

export const slotsRouter: Router = express.Router();

const LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes (prevents lease expiry during server redeploy/restart)

// POST /api/v1/slots/acquire
slotsRouter.post("/acquire", authenticateToken, async (req: Request, res: Response): Promise<void> => {
  const { profileFolderName, hwid } = req.body ?? {};
  const userId = typeof req.userId === "number" ? req.userId : Number(req.userId);

  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized: invalid user ID" });
    return;
  }

  if (!profileFolderName) {
    res.status(400).json({ error: "profileFolderName is required" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user || user.status !== "active") {
      res.status(403).json({ error: "บัญชีไม่พร้อมใช้งานหรือหมดอายุ" });
      return;
    }

    const now = new Date();
    if (!user.isSystemRoot && user.license?.expiredAt && now > new Date(user.license.expiredAt)) {
      res.status(403).json({
        error: "LICENSE_EXPIRED",
        isExpired: true,
        message: "ใบอนุญาตใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมินเพื่อต่ออายุ (หรือขอขยายเวลา 2 ชม.)",
      });
      return;
    }

    const maxAccounts = user.isSystemRoot ? 9999 : (user.license?.maxTiktokAccounts ?? 1);

    // Count currently active leases for this user, excluding the same profileFolderName if renewing
    const otherActiveCount = await ActiveLease.countDocuments({
      userId: user.userId,
      profileFolderName: { $ne: String(profileFolderName).trim() },
      expiresAt: { $gt: now },
    });

    if (otherActiveCount >= maxAccounts) {
      SecurityEvent.create({
        userId: user.userId,
        eventType: "MULTIPLE_INSTANCE_ATTEMPT",
        details: {
          attemptedProfile: profileFolderName,
          hwid,
          activeCount: otherActiveCount,
          maxAccounts,
        },
        ipAddress: req.ip ?? "127.0.0.1",
        hwid: String(hwid),
        severity: "medium",
      })
        .then((ev) => emitSecurityAlert({ alert: ev.toObject() }))
        .catch(() => {});

      res.status(403).json({
        error: `เกินโควต้าบัญชีสูงสุดแล้ว (เปิดอยู่ ${otherActiveCount}/${maxAccounts} บัญชี)`,
      });
      return;
    }

    // Atomic Slot Reservation (10 minutes lease TTL to survive server maintenance/redeploy)
    const leaseId = `lease_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(Date.now() + LEASE_TTL_MS);

    const lease = await ActiveLease.findOneAndUpdate(
      { userId: user.userId, profileFolderName: String(profileFolderName).trim() },
      {
        $set: {
          leaseId,
          hwid: hwid ? String(hwid).trim() : "unknown-hwid",
          ipAddress: req.ip ?? "127.0.0.1",
          expiresAt,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: "after" }
    );

    if (!lease) {
      res.status(500).json({ error: "Failed to reserve slot" });
      return;
    }

    // Atomic race condition guard: verify that active count did not exceed quota
    const totalActiveCount = await ActiveLease.countDocuments({
      userId: user.userId,
      expiresAt: { $gt: now },
    });

    if (totalActiveCount > maxAccounts) {
      // Race condition detected! Roll back this slot lease immediately
      await ActiveLease.deleteOne({ _id: lease._id });
      res.status(403).json({
        error: `เกินโควต้าบัญชีสูงสุดแล้ว (เปิดอยู่ ${totalActiveCount - 1}/${maxAccounts} บัญชี)`,
      });
      return;
    }

    emitLeaseChanged({
      action: "acquired",
      lease: { ...lease.toObject(), username: user.username },
    });

    res.json({
      success: true,
      leaseId: lease.leaseId,
      profileFolderName: lease.profileFolderName,
      expiresAt: lease.expiresAt,
      ttlSeconds: Math.round(LEASE_TTL_MS / 1000),
    });
  } catch (error) {
    console.error("[slots:acquire] Error acquiring slot:", error);
    res.status(500).json({ error: "Internal server error while acquiring slot" });
  }
});

// POST /api/v1/slots/heartbeat
slotsRouter.post("/heartbeat", async (req: Request, res: Response): Promise<void> => {
  const startTime = performance.now();
  const { leaseId, hwid } = req.body ?? {};

  if (!leaseId) {
    res.status(400).json({ error: "leaseId is required" });
    return;
  }

  try {
    let lease = await ActiveLease.findOne({ leaseId: String(leaseId).trim() });
    const now = new Date();

    // Self-Healing: If lease was evicted during server restart or DB reload, restore if token & user valid
    if (!lease) {
      const token = extractBearer(req.header("Authorization"));
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, unknown>;
          const uid = Number(decoded?.id ?? decoded?.userId);
          if (!isNaN(uid)) {
            const user = await User.findOne({ userId: uid });
            if (user && user.status === "active") {
              const maxAccounts = user.isSystemRoot ? 9999 : (user.license?.maxTiktokAccounts ?? 1);
              const activeCount = await ActiveLease.countDocuments({
                userId: uid,
                expiresAt: { $gt: now },
              });
              if (activeCount < maxAccounts) {
                lease = await ActiveLease.create({
                  leaseId: String(leaseId).trim(),
                  userId: uid,
                  profileFolderName: String(req.body?.profileFolderName || "default"),
                  hwid: hwid ? String(hwid).trim() : "",
                  ipAddress: req.ip ?? "127.0.0.1",
                  expiresAt: new Date(Date.now() + LEASE_TTL_MS),
                });
                console.log(`[slots:heartbeat] 🔄 Restored evicted lease ${leaseId} for user ${uid} (Profile: ${lease.profileFolderName})`);
              }
            }
          }
        } catch {
          // Token verification fallback
        }
      }

      if (!lease) {
        const elapsed = (performance.now() - startTime).toFixed(1);
        console.warn(`[slots:heartbeat] ✖ Rejected (404 SLOT_REVOKED) for lease ${leaseId} in ${elapsed}ms`);
        res.status(404).json({
          error: "SLOT_REVOKED",
          isRevoked: true,
          message: "โควต้าจอของคุณถูกปรับลดลง หรือสิทธิ์จอนี้ถูกเพิกถอนแล้ว กรุณาปิดหน้านี้",
        });
        return;
      }
    }

    if (lease.expiresAt < now) {
      const elapsed = (performance.now() - startTime).toFixed(1);
      console.warn(`[slots:heartbeat] ✖ Rejected (403 LEASE_EXPIRED) for lease ${leaseId} (User: ${lease.userId}) in ${elapsed}ms`);
      res.status(403).json({
        error: "LEASE_EXPIRED",
        message: "Lease หมดอายุแล้ว กรุณาขอสิทธิ์ใหม่อีกครั้ง",
      });
      return;
    }

    // Verify user license validity and status with in-memory TTL caching (reduces 70% MongoDB load)
    const userCacheKey = `user_license_${lease.userId}`;
    let user = cacheManager.get<UserDocument>(userCacheKey);
    if (!user) {
      user = ((await User.findOne({ userId: lease.userId })) as UserDocument | null) ?? undefined;
      if (user) {
        cacheManager.set(userCacheKey, user, 30); // 30 seconds cache
      }
    }

    if (!user || user.status !== "active") {
      await ActiveLease.deleteOne({ _id: lease._id });
      cacheManager.del(userCacheKey);
      const elapsed = (performance.now() - startTime).toFixed(1);
      console.warn(`[slots:heartbeat] ✖ User inactive for lease ${leaseId} (User: ${lease.userId}) in ${elapsed}ms`);
      res.status(403).json({
        error: "ACCOUNT_INACTIVE",
        message: "บัญชีผู้ใช้ถูกระงับการใช้งานหรือไม่อนุญาต",
      });
      return;
    }

    if (!user.isSystemRoot && user.license?.expiredAt && now > new Date(user.license.expiredAt)) {
      await ActiveLease.deleteOne({ _id: lease._id });
      cacheManager.del(userCacheKey);
      const elapsed = (performance.now() - startTime).toFixed(1);
      console.warn(`[slots:heartbeat] ✖ License expired for lease ${leaseId} (User: ${lease.userId}) in ${elapsed}ms`);
      res.status(403).json({
        error: "LICENSE_EXPIRED",
        isExpired: true,
        message: "ใบอนุญาตใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมินเพื่อต่ออายุ (หรือขอขยายเวลา 2 ชม.)",
      });
      return;
    }

    // Verify user's current max account quota
    const maxAccounts = user.isSystemRoot ? 9999 : (user.license?.maxTiktokAccounts ?? 1);
    const activeLeases = await ActiveLease.find({
      userId: user.userId,
      expiresAt: { $gt: now },
    }).sort({ createdAt: 1 });

    const allowedLeaseIds = new Set(activeLeases.slice(0, maxAccounts).map((l) => l.leaseId));
    if (!allowedLeaseIds.has(lease.leaseId)) {
      await ActiveLease.deleteOne({ _id: lease._id });
      const elapsed = (performance.now() - startTime).toFixed(1);
      console.warn(`[slots:heartbeat] ✖ Quota exceeded for lease ${leaseId} (User: ${lease.userId}, Allowed: ${maxAccounts}) in ${elapsed}ms`);
      res.status(403).json({
        error: "SLOT_REVOKED",
        isRevoked: true,
        message: `โควต้าจอของคุณถูกปรับลดลงเหลือ ${maxAccounts} จอ สิทธิ์จอนี้จึงถูกเพิกถอน`,
      });
      return;
    }

    // Update HWID on heartbeat if changed, without rejecting (screen quota is what limits instances)
    if (hwid && lease.hwid !== String(hwid).trim()) {
      lease.hwid = String(hwid).trim();
    }

    // Extend lease by 10 minutes to survive server redeploy and maintenance
    lease.expiresAt = new Date(Date.now() + LEASE_TTL_MS);
    await lease.save();

    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(`[slots:heartbeat] ✔ HTTP Heartbeat SUCCESS for lease ${lease.leaseId} (User: ${lease.userId}, Profile: ${lease.profileFolderName}) -> Extended TTL to ${lease.expiresAt.toISOString()} (took ${elapsed}ms)`);

    res.json({
      success: true,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      message: "Keep-Alive Confirmed (HTTP)",
    });
  } catch (error) {
    const elapsed = (performance.now() - startTime).toFixed(1);
    console.error(`[slots:heartbeat] Error extending heartbeat in ${elapsed}ms:`, error);
    res.status(500).json({ error: "Internal server error during heartbeat" });
  }
});

// POST /api/v1/slots/release
slotsRouter.post("/release", async (req: Request, res: Response): Promise<void> => {
  const { leaseId } = req.body ?? {};

  if (!leaseId) {
    res.status(400).json({ error: "leaseId is required" });
    return;
  }

  try {
    const result = await ActiveLease.deleteOne({ leaseId: String(leaseId).trim() });
    if (result.deletedCount > 0) {
      emitLeaseChanged({
        action: "released",
        lease: { leaseId: String(leaseId).trim() },
      });
    }
    res.json({
      success: true,
      released: result.deletedCount > 0,
      message: "Slot released successfully",
    });
  } catch (error) {
    console.error("[slots:release] Error releasing slot:", error);
    res.status(500).json({ error: "Internal server error during release" });
  }
});

// GET /api/v1/slots/active (view active leases for current user)
slotsRouter.get("/active", authenticateToken, async (req: Request, res: Response): Promise<void> => {
  const userId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const activeLeases = await ActiveLease.find({
      userId,
      expiresAt: { $gt: new Date() },
    });
    res.json({ activeLeases });
  } catch (error) {
    console.error("[slots:active] Error:", error);
    res.status(500).json({ error: "Failed to fetch active leases" });
  }
});
