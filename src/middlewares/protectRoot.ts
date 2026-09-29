import mongoose from "mongoose";
import type { Request, Response, NextFunction } from "express";
import { User, type UserDocument } from "../models/User.js";
import { SecurityEvent } from "../models/SecurityEvent.js";

export const protectRoot = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const targetId = req.params.id || req.body.userId || req.body.username;
  const rootUsername = (process.env.ROOT_USERNAME || "root").trim().toLowerCase();

  if (!targetId) {
    next();
    return;
  }

  try {
    let targetUser: UserDocument | null = null;

    if (mongoose.Types.ObjectId.isValid(String(targetId))) {
      targetUser = (await User.findById(targetId)) as UserDocument | null;
    }

    if (!targetUser) {
      if (!isNaN(Number(targetId))) {
        targetUser = (await User.findOne({ userId: Number(targetId) })) as UserDocument | null;
      } else {
        targetUser = (await User.findOne({
          username: String(targetId).toLowerCase().trim(),
        })) as UserDocument | null;
      }
    }

    if (!targetUser) {
      res.status(404).json({ error: "ไม่พบผู้ใช้ในระบบ" });
      return;
    }

    const isRoot = targetUser.isSystemRoot || targetUser.username.toLowerCase() === rootUsername;

    if (isRoot) {
      if (req.method === "DELETE") {
        void SecurityEvent.create({
          userId: typeof req.userId === "number" ? req.userId : 0,
          eventType: "ROOT_PROTECTION_TRIGGERED",
          details: {
            action: "DELETE_ROOT_ATTEMPT",
            targetUserId: targetUser.userId,
            targetUsername: targetUser.username,
          },
          ipAddress: req.ip ?? "127.0.0.1",
          severity: "critical",
        });

        res.status(403).json({
          error: "สิทธิ์ถูกปฏิเสธ: ไม่สามารถลบหรือระงับบัญชี Root ของระบบได้",
        });
        return;
      }

      const body = req.body ?? {};
      if (body.status === "suspended" || body.status === "expired" || body.isSystemRoot === false) {
        void SecurityEvent.create({
          userId: typeof req.userId === "number" ? req.userId : 0,
          eventType: "ROOT_PROTECTION_TRIGGERED",
          details: {
            action: "SUSPEND_ROOT_ATTEMPT",
            targetUserId: targetUser.userId,
            targetUsername: targetUser.username,
            attemptedStatus: body.status,
          },
          ipAddress: req.ip ?? "127.0.0.1",
          severity: "high",
        });

        res.status(403).json({
          error: "สิทธิ์ถูกปฏิเสธ: ไม่สามารถลบหรือระงับบัญชี Root ของระบบได้",
        });
        return;
      }
    }

    next();
  } catch (error) {
    console.error("[protectRoot] Error checking root status:", error);
    res.status(500).json({ error: "Internal server error during root protection check" });
  }
};
