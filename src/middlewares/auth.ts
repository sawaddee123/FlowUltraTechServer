import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { User, type UserDocument } from "../models/User.js";
import { ActiveLease } from "../models/ActiveLease.js";
import { SecurityEvent } from "../models/SecurityEvent.js";
import { cacheManager } from "../services/cacheManager.js";

export const JWT_SECRET = env.JWT_TOKEN;
export const JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET || env.JWT_TOKEN;

export const extractBearer = (raw: string | undefined): string | null => {
  if (typeof raw !== "string" || !raw) return null;
  const stripped = raw.replace(/^Bearer\s+/i, "").trim();
  return stripped || null;
};

export const authenticateToken = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const accessToken = extractBearer(req.header("Authorization")) || queryToken;
  if (!accessToken) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  jwt.verify(accessToken, JWT_SECRET, { algorithms: ["HS256"] }, (err, decoded) => {
    if (err) {
      res.status(401).json({ error: "Token expired" });
      return;
    }
    const payload = decoded as jwt.JwtPayload | undefined;
    const id = payload?.id;
    if (typeof id !== "number" && typeof id !== "string") {
      res.status(400).json({ error: "Invalid user ID format" });
      return;
    }

    req.userId = typeof id === "number" ? id : isNaN(Number(id)) ? id : Number(id);
    if (typeof payload?.jti === "string") req.jti = payload.jti;
    next();
  });
};

export const verifyActiveLease = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const leaseHeader = req.header("X-Instance-Lease") || req.header("x-instance-lease");
  const leaseId = Array.isArray(leaseHeader) ? leaseHeader[0] : leaseHeader;
  const userId = req.userId;
  const numericUserId = typeof userId === "number" ? userId : Number(userId);

  // Check if current user is system root (roots are allowed bypass or can use lease)
  let currentUser = req.user;
  if (!currentUser && !isNaN(numericUserId)) {
    try {
      currentUser = ((await cacheManager.getOrSet(
        `user:id:${numericUserId}`,
        async () => (await User.findOne({ userId: numericUserId })) as UserDocument | null,
        60
      )) as UserDocument | null) ?? undefined;
      if (currentUser) req.user = currentUser;
    } catch {
      // ignore
    }
  }

  if (!leaseId) {
    if (currentUser?.isSystemRoot) {
      next();
      return;
    }

    res.status(403).json({
      error: "ปฏิเสธการให้บริการ: ต้องแนบ X-Instance-Lease ของจอที่ได้รับอนุญาตเท่านั้น",
    });
    return;
  }

  try {
    const activeLease = await cacheManager.getOrSet(
      `lease:${leaseId}`,
      async () => {
        const l = await ActiveLease.findOne({
          leaseId,
          expiresAt: { $gt: new Date() },
        });
        return l ? l.toObject() : null;
      },
      15
    );

    if (!activeLease) {
      if (!isNaN(numericUserId)) {
        void SecurityEvent.create({
          userId: numericUserId,
          eventType: "EXPIRED_LEASE_ABUSE",
          details: { leaseId, reason: "Lease expired or not found" },
          ipAddress: req.ip ?? "127.0.0.1",
          severity: "medium",
        });
      }

      res.status(403).json({
        error: "Lease หมดอายุหรือตรวจพบการใช้งานนอกระบบที่ได้รับอนุญาต",
      });
      return;
    }

    // If request has authenticated user, ensure lease belongs to this user (unless system root)
    if (!isNaN(numericUserId) && !currentUser?.isSystemRoot && activeLease.userId !== numericUserId) {
      void SecurityEvent.create({
        userId: numericUserId,
        eventType: "EXPIRED_LEASE_ABUSE",
        details: {
          leaseId,
          leaseUserId: activeLease.userId,
          requestUserId: numericUserId,
          reason: "Lease user mismatch",
        },
        ipAddress: req.ip ?? "127.0.0.1",
        severity: "high",
      });

      res.status(403).json({
        error: "Lease หมดอายุหรือตรวจพบการใช้งานนอกระบบที่ได้รับอนุญาต",
      });
      return;
    }

    req.activeLease = activeLease;
    next();
  } catch (error) {
    console.error("[verifyActiveLease] Error verifying lease:", error);
    res.status(500).json({ error: "Internal server error during lease verification" });
  }
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (req.userId === undefined) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const numericUserId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  if (isNaN(numericUserId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user =
      req.user ??
      ((await cacheManager.getOrSet(
        `user:id:${numericUserId}`,
        async () => (await User.findOne({ userId: numericUserId })) as UserDocument | null,
        60
      )) as UserDocument | null);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    req.user = user;

    if (user.role === "admin" || user.role === "superadmin" || user.isSystemRoot) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden: Admin access required" });
  } catch (error) {
    console.error("[requireAdmin] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const requireSuperAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // Support both Header Authorization and Query param (?token=...) for image tags
  if (req.userId === undefined && req.query.token && typeof req.query.token === "string") {
    try {
      const decoded = jwt.verify(req.query.token, JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      if (decoded.id !== undefined) req.userId = decoded.id;
    } catch {
      // ignore
    }
  }

  if (req.userId === undefined) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const numericUserId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  if (isNaN(numericUserId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user =
      req.user ??
      ((await cacheManager.getOrSet(
        `user:id:${numericUserId}`,
        async () => (await User.findOne({ userId: numericUserId })) as UserDocument | null,
        60
      )) as UserDocument | null);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    req.user = user;

    if (user.role === "superadmin" || user.isSystemRoot) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden: Superadmin access required" });
  } catch (error) {
    console.error("[requireSuperAdmin] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};


export const checkIsJson = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.is("application/json")) {
    res.status(400).json({ error: "Request not JSON" });
    return;
  }
  next();
};
