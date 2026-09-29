import express, { type Router, type Request, type Response } from "express";
import { authenticateToken } from "../middlewares/auth.js";
import { SecurityEvent } from "../models/SecurityEvent.js";
import { User, type UserDocument } from "../models/User.js";
import { recordAuditLog } from "../services/auditLogger.js";
import { emitSecurityAlert } from "../services/socketHub.js";

export const securityRouter: Router = express.Router();

// POST /api/v1/security/event
securityRouter.post("/event", authenticateToken, async (req: Request, res: Response): Promise<void> => {
  const userId = typeof req.userId === "number" ? req.userId : Number(req.userId);
  const { eventType, details, hwid, profileFolder, severity } = req.body ?? {};

  if (!eventType) {
    res.status(400).json({ error: "eventType is required" });
    return;
  }

  try {
    const user = !isNaN(userId)
      ? ((await User.findOne({ userId })) as UserDocument | null)
      : null;

    const eventDetails =
      typeof details === "object" && details !== null
        ? { ...details, profileFolder }
        : { message: details, profileFolder };

    const secEvent = await SecurityEvent.create({
      userId: isNaN(userId) ? 0 : userId,
      eventType: String(eventType),
      details: eventDetails,
      ipAddress: req.ip ?? "127.0.0.1",
      hwid: hwid ? String(hwid) : "",
      severity: severity && ["low", "medium", "high", "critical"].includes(severity) ? severity : "medium",
    });

    emitSecurityAlert({ alert: secEvent.toObject() });

    await recordAuditLog({
      actor: {
        userId: isNaN(userId) ? 0 : userId,
        username: user?.username ?? `user_${userId}`,
        role: user?.role ?? "user",
        ipAddress: req.ip ?? "127.0.0.1",
      },
      action: "SECURITY_INCIDENT",
      category: "security",
      targetId: String(userId),
      targetType: "SecurityEvent",
      summary: `Client security incident: ${eventType} (${user?.username ?? userId})`,
      metadata: { eventType, details: eventDetails, hwid, profileFolder },
      isReversible: false,
    });

    res.json({
      success: true,
      eventId: secEvent._id,
      recordedAt: secEvent.createdAt ?? new Date(),
    });
  } catch (error) {
    console.error("[security:event] Error logging security event:", error);
    res.status(500).json({ error: "Internal server error logging security event" });
  }
});
