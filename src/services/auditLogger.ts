import crypto from "node:crypto";
import { AuditLog, type AuditAction, type AuditCategory, type AuditActor } from "../models/AuditLog.js";
import { User, type UserDocument } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { ActiveLease } from "../models/ActiveLease.js";
import { cacheManager } from "./cacheManager.js";
import { emitAuditLogged } from "./socketHub.js";

export interface RecordAuditOptions {
  actor: AuditActor;
  action: AuditAction;
  category: AuditCategory;
  targetId?: string;
  targetType?: string;
  summary: string;
  changes?: {
    before?: any;
    after?: any;
  };
  isReversible?: boolean;
  metadata?: any;
}

export const recordAuditLog = async (options: RecordAuditOptions): Promise<string | null> => {
  try {
    const logId = crypto.randomUUID();
    const createdLog = await AuditLog.create({
      logId,
      timestamp: new Date(),
      actor: options.actor,
      action: options.action,
      category: options.category,
      targetId: options.targetId,
      targetType: options.targetType,
      summary: options.summary,
      changes: options.changes,
      isReversible: options.isReversible ?? false,
      isReverted: false,
      metadata: options.metadata,
    });
    emitAuditLogged({ log: createdLog.toObject() });
    return logId;
  } catch (error) {
    console.error("[AuditLogger] Error recording audit log:", error);
    return null;
  }
};

export interface RevertResult {
  success: boolean;
  message: string;
  action: AuditAction;
  targetId?: string;
  restoredData?: unknown;
}

export const executeRevert = async (
  logIdOrId: string,
  actor: AuditActor
): Promise<RevertResult> => {
  // Find log by logId or MongoDB _id
  const log = await AuditLog.findOne({
    $or: [{ logId: logIdOrId }, { _id: logIdOrId.match(/^[0-9a-fA-F]{24}$/) ? logIdOrId : undefined }],
  });

  if (!log) {
    throw new Error("Audit log not found");
  }

  if (!log.isReversible) {
    throw new Error(`Action '${log.action}' is not reversible`);
  }

  if (log.isReverted) {
    throw new Error(`This action was already reverted on ${log.revertedAt?.toISOString()}`);
  }

  const beforeData = log.changes?.before as any;
  const afterData = log.changes?.after as any;

  switch (log.action) {
    case "USER_UPDATE":
    case "USER_GRACE_PERIOD": {
      if (!beforeData) throw new Error("Missing pre-modification snapshot data");
      const targetUsername = String(beforeData.username || log.targetId);
      const user = await User.findOne({
        $or: [{ username: targetUsername.toLowerCase().trim() }, { userId: Number(beforeData.userId) }],
      });

      if (!user) {
        throw new Error(`Target user '${targetUsername}' does not exist, cannot revert update`);
      }

      // Restore fields from before snapshot
      if (beforeData.license) user.license = beforeData.license as any;
      if (beforeData.status) user.status = beforeData.status as any;
      if (beforeData.role) user.role = beforeData.role as any;
      if (beforeData.email !== undefined) user.email = beforeData.email as any;
      if (beforeData.settings) user.settings = beforeData.settings as any;
      if (beforeData.captchaQuota) user.captchaQuota = beforeData.captchaQuota as any;
      if (beforeData.passwordHash) user.passwordHash = String(beforeData.passwordHash);

      await user.save();
      cacheManager.delPrefix("user:");

      // Mark log as reverted
      log.isReverted = true;
      log.revertedAt = new Date();
      log.revertedBy = { userId: actor.userId, username: actor.username };
      await log.save();

      // Record revert log
      await recordAuditLog({
        actor,
        action: "AUDIT_REVERT",
        category: "user",
        targetId: user.username,
        targetType: "User",
        summary: `ย้อนคืนข้อมูลผู้ใช้ '${user.username}' จากบันทึก ${log.logId}`,
        changes: { before: afterData, after: beforeData },
        isReversible: false,
        metadata: { originalLogId: log.logId },
      });

      const { passwordHash: _, ...safeUser } = user.toObject();
      void _;
      return {
        success: true,
        message: `ย้อนคืนข้อมูลผู้ใช้ '${user.username}' สำเร็จ`,
        action: log.action,
        targetId: user.username,
        restoredData: safeUser,
      };
    }

    case "USER_DELETE": {
      if (!beforeData) throw new Error("Missing snapshot of deleted user");
      const targetUsername = String(beforeData.username || log.targetId).toLowerCase().trim();

      const existing = await User.findOne({ username: targetUsername });
      if (existing) {
        throw new Error(`Cannot restore user '${targetUsername}': a user with this username already exists`);
      }

      // Recreate user document with original fields
      const restoredUser: any = await User.create({
        userId: beforeData.userId,
        username: targetUsername,
        email: beforeData.email,
        passwordHash: beforeData.passwordHash,
        role: beforeData.role || "user",
        isSystemRoot: beforeData.isSystemRoot || false,
        status: beforeData.status || "active",
        license: beforeData.license,
        captchaQuota: beforeData.captchaQuota,
        settings: beforeData.settings,
        createdAt: beforeData.createdAt || new Date(),
      } as any);

      cacheManager.delPrefix("user:");

      log.isReverted = true;
      log.revertedAt = new Date();
      log.revertedBy = { userId: actor.userId, username: actor.username };
      await log.save();

      await recordAuditLog({
        actor,
        action: "AUDIT_REVERT",
        category: "user",
        targetId: targetUsername,
        targetType: "User",
        summary: `กู้คืนผู้ใช้ที่ถูกลบ '${targetUsername}' (ID: ${restoredUser.userId}) จากบันทึก ${log.logId}`,
        changes: { before: null, after: beforeData },
        isReversible: false,
        metadata: { originalLogId: log.logId },
      });

      const { passwordHash: _, ...safeUser } = restoredUser.toObject();
      void _;
      return {
        success: true,
        message: `กู้คืนผู้ใช้ '${targetUsername}' กลับมาสำเร็จ`,
        action: log.action,
        targetId: targetUsername,
        restoredData: safeUser,
      };
    }

    case "USER_CREATE": {
      if (!afterData) throw new Error("Missing snapshot of created user");
      const targetUsername = String(afterData.username || log.targetId).toLowerCase().trim();

      const user = await User.findOne({ username: targetUsername });
      if (!user) {
        throw new Error(`User '${targetUsername}' is already removed`);
      }

      if (user.isSystemRoot) {
        throw new Error("Cannot delete System Root user during revert");
      }

      await User.deleteOne({ _id: user._id });
      cacheManager.delPrefix("user:");

      log.isReverted = true;
      log.revertedAt = new Date();
      log.revertedBy = { userId: actor.userId, username: actor.username };
      await log.save();

      await recordAuditLog({
        actor,
        action: "AUDIT_REVERT",
        category: "user",
        targetId: targetUsername,
        targetType: "User",
        summary: `ยกเลิกการสร้างผู้ใช้ '${targetUsername}' จากบันทึก ${log.logId}`,
        changes: { before: afterData, after: null },
        isReversible: false,
        metadata: { originalLogId: log.logId },
      });

      return {
        success: true,
        message: `ยกเลิกการสร้างผู้ใช้ '${targetUsername}' สำเร็จ`,
        action: log.action,
        targetId: targetUsername,
      };
    }

    case "DEVICE_RESET": {
      if (!Array.isArray(beforeData)) {
        throw new Error("Invalid session snapshot for device reset revert");
      }

      let restoredCount = 0;
      if (beforeData.length > 0) {
        const docs = beforeData.map((s: any) => ({
          ...s,
          expiresAt: new Date(s.expiresAt || Date.now() + 7 * 24 * 60 * 60 * 1000),
        }));
        await RefreshToken.insertMany(docs, { ordered: false });
        restoredCount = docs.length;
      }

      cacheManager.delPrefix("device:");

      log.isReverted = true;
      log.revertedAt = new Date();
      log.revertedBy = { userId: actor.userId, username: actor.username };
      await log.save();

      await recordAuditLog({
        actor,
        action: "AUDIT_REVERT",
        category: "security",
        targetId: log.targetId,
        targetType: "RefreshToken",
        summary: `กู้คืน ${restoredCount} เซสชันเครื่องที่ถูกล้างของ '${log.targetId}' จากบันทึก ${log.logId}`,
        changes: { before: null, after: beforeData },
        isReversible: false,
        metadata: { originalLogId: log.logId },
      });

      return {
        success: true,
        message: `กู้คืนเซสชันเครื่อง (${restoredCount} เครื่อง) ของ '${log.targetId}' สำเร็จ`,
        action: log.action,
        targetId: log.targetId,
      };
    }

    case "LEASE_RELEASE": {
      if (!beforeData) throw new Error("Missing snapshot of released lease");
      const leaseId = String(beforeData.leaseId || log.targetId);

      const existing = await ActiveLease.findOne({ leaseId });
      if (!existing) {
        await ActiveLease.create({
          leaseId,
          userId: Number(beforeData.userId),
          profileFolderName: String(beforeData.profileFolderName),
          hwid: String(beforeData.hwid),
          expiresAt: new Date(Date.now() + 60 * 1000), // restore with 60s lease
        } as any);
      }

      cacheManager.delPrefix("lease:");

      log.isReverted = true;
      log.revertedAt = new Date();
      log.revertedBy = { userId: actor.userId, username: actor.username };
      await log.save();

      await recordAuditLog({
        actor,
        action: "AUDIT_REVERT",
        category: "lease",
        targetId: leaseId,
        targetType: "ActiveLease",
        summary: `กู้คืนสิทธิ์จอ '${leaseId}' จากบันทึก ${log.logId}`,
        changes: { before: null, after: beforeData },
        isReversible: false,
      });

      return {
        success: true,
        message: `กู้คืนสิทธิ์จอ '${leaseId}' สำเร็จ`,
        action: log.action,
        targetId: leaseId,
      };
    }

    default:
      throw new Error(`Revert not supported for action '${log.action}'`);
  }
};
