import type { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { User, type UserDocument } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { ActiveLease } from "../models/ActiveLease.js";
import { CaptchaLog } from "../models/CaptchaLog.js";
import { InstanceProfile } from "../models/InstanceProfile.js";
import { Proxy } from "../models/Proxy.js";
import { AuditLog } from "../models/AuditLog.js";
import { AppRelease } from "../models/AppRelease.js";
import { recordAuditLog, executeRevert } from "../services/auditLogger.js";
import { cacheManager } from "../services/cacheManager.js";
import { detectFileVersion, calculateFileSha256, compareSemver, extractVersionFromFilename } from "../utils/versionDetector.js";
import { renderOverlayOnImage } from "../utils/imageOverlay.js";
import {
  emitQuotaReduced,
  emitLicenseKickout,
  emitLicenseUpdated,
  emitLeaseChanged,
  emitAppUpdate,
  getOnlineUsersWithLeases,
} from "../services/socketHub.js";

export const isSuperAdminUser = (req: Request): boolean => {
  return req.user?.role === "superadmin" || req.user?.isSystemRoot === true;
};

export const getActorFromReq = (req: Request) => {
  return {
    userId: req.user?.userId || 0,
    username: req.user?.username || "unknown",
    role: req.user?.role || "admin",
    ipAddress: req.ip ?? req.socket.remoteAddress ?? "127.0.0.1",
  };
};

export const findUserByIdOrParam = async (idParam: string): Promise<UserDocument | null> => {
  if (mongoose.Types.ObjectId.isValid(idParam)) {
    const byId = (await User.findById(idParam)) as UserDocument | null;
    if (byId) return byId;
  }
  if (!isNaN(Number(idParam))) {
    const byUserId = (await User.findOne({ userId: Number(idParam) })) as UserDocument | null;
    if (byUserId) return byUserId;
  }
  return (await User.findOne({ username: idParam.toLowerCase().trim() })) as UserDocument | null;
};

export class AdminController {
  // GET /api/v1/admin/users
  static async getUsers(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "20"), 10) || 20));
      const search = String(req.query.search || "").trim();
      const role = String(req.query.role || "all").trim();

      const query: Record<string, any> = {};

      if (role && role !== "all") {
        query.role = role;
      }

      if (search) {
        const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const searchRegex = new RegExp(escapedSearch, "i");
        const numericId = Number(search);
        if (!isNaN(numericId) && Number.isInteger(numericId)) {
          query.$or = [{ username: searchRegex }, { userId: numericId }];
        } else {
          query.username = searchRegex;
        }
      }

      const skip = (page - 1) * limit;
      const now = new Date();

      const [users, total] = await Promise.all([
        User.find(query).select("-passwordHash").sort({ createdAt: -1 }).skip(skip).limit(limit),
        User.countDocuments(query),
      ]);

      const pageUserIds = users.map((u) => u.userId);

      const [leaseAgg, deviceAgg] = await Promise.all([
        ActiveLease.aggregate([
          { $match: { userId: { $in: pageUserIds }, expiresAt: { $gt: now } } },
          { $group: { _id: "$userId", count: { $sum: 1 } } },
        ]),
        RefreshToken.aggregate([
          { $match: { userId: { $in: pageUserIds }, expiresAt: { $gt: now } } },
          { $group: { _id: "$userId", devices: { $addToSet: "$device.hwid" } } },
        ]),
      ]);

      const leaseMap = new Map<number, number>();
      for (const row of leaseAgg) {
        leaseMap.set(Number(row._id), Number(row.count) || 0);
      }

      const deviceMap = new Map<number, number>();
      for (const row of deviceAgg) {
        deviceMap.set(Number(row._id), Array.isArray(row.devices) ? row.devices.length : 0);
      }

      const userList = users.map((u) => ({
        ...u.toObject(),
        activeLeaseCount: leaseMap.get(u.userId) || 0,
        activeDeviceCount: deviceMap.get(u.userId) || 0,
      }));

      const totalPages = Math.ceil(total / limit) || 1;

      res.json({
        users: userList,
        total,
        page,
        limit,
        totalPages,
      });
    } catch (error) {
      console.error("[admin:getUsers] Error:", error);
      res.status(500).json({ error: "Failed to retrieve users" });
    }
  }

  // POST /api/v1/admin/users
  static async createUser(req: Request, res: Response): Promise<void> {
    const {
      username,
      password,
      email,
      role = "user",
      plan = "standard",
      expiredAt,
      deviceLimit = 9999,
      maxTiktokAccounts = 1,
      dailyLimit = 500,
      settings,
    } = req.body ?? {};

    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const isSuper = isSuperAdminUser(req);
    if (role === "superadmin") {
      res.status(403).json({
        error: "ไม่อนุญาตให้สร้างบัญชีระดับ 'superadmin' เพิ่มเติม (สงวนสิทธิ์เฉพาะ root เท่านั้น)",
      });
      return;
    }
    if (!isSuper && role && role !== "user") {
      res.status(403).json({
        error: "สิทธิ์ไม่เพียงพอ: Admin ทั่วไปสามารถสร้างได้เฉพาะผู้ใช้ระดับ 'user' เท่านั้น",
      });
      return;
    }

    const normalizedUsername = String(username).toLowerCase().trim();

    try {
      const existing = await User.findOne({ username: normalizedUsername });
      if (existing) {
        res.status(409).json({ error: "Username already exists" });
        return;
      }

      const lastUser = await User.findOne().sort({ userId: -1 });
      const nextUserId =
        lastUser && typeof lastUser.userId === "number" && lastUser.userId >= 1000000
          ? lastUser.userId + 1
          : 1000001;

      const passwordHash = await bcrypt.hash(String(password), 10);
      const expirationDate = expiredAt
        ? new Date(expiredAt)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const newUser = await User.create({
        userId: nextUserId,
        username: normalizedUsername,
        email: email ? String(email).toLowerCase().trim() : undefined,
        passwordHash,
        role: isSuper && role === "admin" ? "admin" : "user",
        isSystemRoot: false,
        status: "active",
        expiredAt: expirationDate,
        license: {
          plan: String(plan),
          expiredAt: expirationDate,
          deviceLimit: Number(deviceLimit) || 9999,
          maxTiktokAccounts: Number(maxTiktokAccounts) || 1,
        },
        captchaQuota: {
          dailyLimit: Number(dailyLimit) || 500,
          usedToday: 0,
          lastResetDate: new Date(),
        },
        settings: {
          telegramBotToken: settings?.telegramBotToken || "",
          telegramChatId: settings?.telegramChatId || "",
          autoSolveDelaySeconds: Number(settings?.autoSolveDelaySeconds) || 5,
          captchaSoundVolume: Number(settings?.captchaSoundVolume) || 80,
          autoSaveCaptchaImage: settings?.autoSaveCaptchaImage ?? true,
        },
      });

      cacheManager.delPrefix("user:");
      cacheManager.del("stats:dashboard");

      const userObj = newUser.toObject();
      const { passwordHash: _, ...safeUser } = userObj;
      void _;

      void recordAuditLog({
        actor: getActorFromReq(req),
        action: "USER_CREATE",
        category: "user",
        targetId: newUser.username,
        targetType: "User",
        summary: `สร้างผู้ใช้งานใหม่ '${newUser.username}' (โควต้า ${newUser.license.maxTiktokAccounts} จอ, ไม่จำกัดเครื่อง)`,
        changes: { before: null, after: userObj },
        isReversible: true,
      });

      res.status(201).json({ success: true, user: safeUser });
    } catch (error) {
      console.error("[admin:createUser] Error:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  }

  // GET /api/v1/admin/users/:id
  static async getUserById(req: Request, res: Response): Promise<void> {
    try {
      const user = await findUserByIdOrParam(req.params.id);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const now = new Date();
      const activeLeases = await ActiveLease.find({
        userId: user.userId,
        expiresAt: { $gt: now },
      });
      const activeSessions = await RefreshToken.find({
        userId: user.userId,
        expiresAt: { $gt: now },
      });
      const profiles = await InstanceProfile.find({ userId: user.userId }).sort({ profileFolderName: 1 }).lean();
      const proxies = await Proxy.find({ userId: user.userId }).sort({ proxifierId: 1 }).lean();

      const userObj = user.toObject();
      const { passwordHash: _, ...safeUser } = userObj;
      void _;

      res.json({
        user: safeUser,
        activeLeases,
        activeSessions,
        profiles,
        proxies,
      });
    } catch (error) {
      console.error("[admin:getUserById] Error:", error);
      res.status(500).json({ error: "Failed to retrieve user" });
    }
  }

  // PUT /api/v1/admin/users/:id
  static async updateUser(req: Request, res: Response): Promise<void> {
    try {
      const user = await findUserByIdOrParam(req.params.id);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const isSuper = isSuperAdminUser(req);

      if (!isSuper && (user.role === "admin" || user.role === "superadmin" || user.isSystemRoot)) {
        res.status(403).json({
          error: "สิทธิ์ไม่เพียงพอ: Admin ทั่วไปไม่สามารถแก้ไขข้อมูลของผู้ดูแลระบบคนอื่นได้",
        });
        return;
      }

      const body = req.body ?? {};

      if (body.role === "superadmin" && !user.isSystemRoot) {
        res.status(403).json({
          error: "ไม่อนุญาตให้เปลี่ยนผู้ใช้เป็น 'superadmin' (สงวนสิทธิ์เฉพาะ root เท่านั้น)",
        });
        return;
      }
      if (user.isSystemRoot && body.role && body.role !== "superadmin") {
        res.status(403).json({
          error: "ไม่อนุญาตให้เปลี่ยนระดับสิทธิ์ของ root",
        });
        return;
      }

      if (!isSuper && body.role && body.role !== "user") {
        res.status(403).json({
          error: "สิทธิ์ไม่เพียงพอ: Admin ทั่วไปไม่สามารถเลื่อนขั้นสิทธิ์ผู้ใช้งานได้",
        });
        return;
      }

      const beforeSnapshot = user.toObject();
      const oldMaxAccounts = user.license?.maxTiktokAccounts ?? 1;

      if (body.password) {
        user.passwordHash = await bcrypt.hash(String(body.password), 10);
      }

      if (!user.isSystemRoot) {
        if (body.role && ["admin", "user"].includes(body.role)) {
          if (isSuper || body.role === "user") {
            user.role = body.role;
          }
        }
        if (body.status && ["active", "suspended", "expired"].includes(body.status)) {
          user.status = body.status;
        }
      }

      if (body.email !== undefined) {
        user.email = body.email ? String(body.email).toLowerCase().trim() : undefined;
      }

      if (body.license) {
        user.license = {
          plan: body.license.plan ?? user.license?.plan ?? "standard",
          expiredAt: body.license.expiredAt ? new Date(body.license.expiredAt) : user.license?.expiredAt,
          deviceLimit: body.license.deviceLimit !== undefined ? Number(body.license.deviceLimit) : (user.license?.deviceLimit ?? 9999),
          maxTiktokAccounts: body.license.maxTiktokAccounts !== undefined ? Number(body.license.maxTiktokAccounts) : (user.license?.maxTiktokAccounts ?? 1),
        };
      }

      let quotaChanged = false;
      if (body.maxTiktokAccounts !== undefined) {
        user.license.maxTiktokAccounts = Math.max(1, Number(body.maxTiktokAccounts));
        quotaChanged = true;
      }
      if (body.deviceLimit !== undefined) {
        user.license.deviceLimit = Math.max(1, Number(body.deviceLimit));
      }

      if (body.addHours !== undefined && Number(body.addHours) > 0) {
        const hoursToAdd = Number(body.addHours);
        const baseTime = user.license?.expiredAt && new Date(user.license.expiredAt).getTime() > Date.now()
          ? new Date(user.license.expiredAt).getTime()
          : Date.now();
        const newExpiry = new Date(baseTime + hoursToAdd * 3600 * 1000);
        user.license.expiredAt = newExpiry;
        user.expiredAt = newExpiry;
        user.status = "active";
      } else if ((body.addDays !== undefined && Number(body.addDays) > 0) || (body.extendDays !== undefined && Number(body.extendDays) > 0)) {
        const daysToAdd = Number(body.addDays ?? body.extendDays);
        const baseTime = user.license?.expiredAt && new Date(user.license.expiredAt).getTime() > Date.now()
          ? new Date(user.license.expiredAt).getTime()
          : Date.now();
        const newExpiry = new Date(baseTime + daysToAdd * 86400 * 1000);
        user.license.expiredAt = newExpiry;
        user.expiredAt = newExpiry;
        user.status = "active";
      } else if (body.expiredAt !== undefined) {
        const newExpiry = new Date(body.expiredAt);
        if (!isNaN(newExpiry.getTime())) {
          user.license.expiredAt = newExpiry;
          user.expiredAt = newExpiry;
          if (newExpiry.getTime() > Date.now() && user.status === "expired") {
            user.status = "active";
          } else if (newExpiry.getTime() <= Date.now()) {
            user.status = "expired";
          }
        }
      }

      if (quotaChanged && user.license.maxTiktokAccounts < oldMaxAccounts) {
        const newMax = user.license.maxTiktokAccounts;
        const activeLeases = await ActiveLease.find({
          userId: user.userId,
          expiresAt: { $gt: new Date() },
        }).sort({ createdAt: -1 });

        const revokedIds: string[] = [];
        if (activeLeases.length > newMax) {
          const excessCount = activeLeases.length - newMax;
          const leasesToRevoke = activeLeases.slice(0, excessCount);
          for (const lease of leasesToRevoke) {
            await ActiveLease.deleteOne({ _id: lease._id });
            cacheManager.del(`lease:${lease.leaseId}`);
            cacheManager.del(`lease:${lease.leaseId}:user`);
            revokedIds.push(lease.leaseId);
            emitLeaseChanged({ action: "revoked", lease: lease.toObject() });
          }
          console.log(`[admin:updateUser] Quota reduced for user '${user.username}' (${oldMaxAccounts} -> ${newMax}). Revoked ${excessCount} active leases.`);
        }
        emitQuotaReduced(user.userId, { newMax, revokedLeaseIds: revokedIds });
      }

      if (body.captchaQuota) {
        user.captchaQuota = {
          dailyLimit: body.captchaQuota.dailyLimit !== undefined ? Number(body.captchaQuota.dailyLimit) : user.captchaQuota.dailyLimit,
          usedToday: body.captchaQuota.usedToday !== undefined ? Number(body.captchaQuota.usedToday) : user.captchaQuota.usedToday,
          lastResetDate: user.captchaQuota.lastResetDate ?? new Date(),
        };
      }

      if (body.settings) {
        user.settings = {
          telegramBotToken: body.settings.telegramBotToken ?? user.settings?.telegramBotToken ?? "",
          telegramChatId: body.settings.telegramChatId ?? user.settings?.telegramChatId ?? "",
          autoSolveDelaySeconds: body.settings.autoSolveDelaySeconds !== undefined ? Number(body.settings.autoSolveDelaySeconds) : (user.settings?.autoSolveDelaySeconds ?? 5),
          captchaSoundVolume: body.settings.captchaSoundVolume !== undefined ? Number(body.settings.captchaSoundVolume) : (user.settings?.captchaSoundVolume ?? 80),
          autoSaveCaptchaImage: body.settings.autoSaveCaptchaImage ?? user.settings?.autoSaveCaptchaImage ?? true,
        };
      }

      if (user.license?.expiredAt) {
        user.expiredAt = user.license.expiredAt;
      }

      await user.save();
      cacheManager.delPrefix("user:");
      cacheManager.del("stats:dashboard");

      if (user.status === "suspended" || user.status === "expired") {
        emitLicenseKickout(user.userId, { reason: `Account status is ${user.status}` });
      }

      emitLicenseUpdated(user.userId, {
        expiredAt: user.license?.expiredAt,
        maxTiktokAccounts: user.license?.maxTiktokAccounts,
        status: user.status,
        plan: user.license?.plan,
      });

      const afterSnapshot = user.toObject();
      const { passwordHash: _, ...safeUser } = afterSnapshot;
      void _;

      void recordAuditLog({
        actor: getActorFromReq(req),
        action: "USER_UPDATE",
        category: "user",
        targetId: user.username,
        targetType: "User",
        summary: `แก้ไขข้อมูลผู้ใช้ '${user.username}' (โควต้า ${user.license.maxTiktokAccounts} จอ, สถานะ ${user.status})`,
        changes: { before: beforeSnapshot, after: afterSnapshot },
        isReversible: true,
      });

      res.json({ success: true, user: safeUser });
    } catch (error) {
      console.error("[admin:updateUser] Error:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  }

  // POST /api/v1/admin/users/:id/grace-period
  static async grantGracePeriod(req: Request, res: Response): Promise<void> {
    try {
      const user = await findUserByIdOrParam(req.params.id);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const hours = Math.max(1, Number(req.body?.hours) || 2);
      const baseTime = user.license?.expiredAt && new Date(user.license.expiredAt).getTime() > Date.now()
        ? new Date(user.license.expiredAt).getTime()
        : Date.now();
      const newExpiry = new Date(baseTime + hours * 3600 * 1000);

      const beforeSnapshot = user.toObject();
      if (!user.license) {
        user.license = {
          plan: "standard",
          expiredAt: newExpiry,
          deviceLimit: 9999,
          maxTiktokAccounts: 1,
        };
      } else {
        user.license.expiredAt = newExpiry;
      }
      user.expiredAt = newExpiry;
      user.status = "active";
      await user.save();

      cacheManager.delPrefix("user:");
      cacheManager.del("stats:dashboard");

      emitLicenseUpdated(user.userId, {
        expiredAt: newExpiry,
        maxTiktokAccounts: user.license?.maxTiktokAccounts,
        status: user.status,
        plan: user.license?.plan,
      });

      const afterSnapshot = user.toObject();
      void recordAuditLog({
        actor: getActorFromReq(req),
        action: "USER_GRACE_PERIOD",
        category: "user",
        targetId: user.username,
        targetType: "User",
        summary: `ต่อเวลาใช้งานฉุกเฉิน (Grace Period) +${hours} ชม. ให้กับผู้ใช้ '${user.username}' (หมดอายุ: ${newExpiry.toISOString()})`,
        changes: { before: beforeSnapshot, after: afterSnapshot },
        isReversible: true,
      });

      res.json({
        success: true,
        message: `ต่อเวลา ${hours} ชั่วโมงให้กับ '${user.username}' เรียบร้อยแล้ว`,
        expiredAt: newExpiry,
        user: {
          userId: user.userId,
          username: user.username,
          status: user.status,
          expiredAt: user.expiredAt,
          license: user.license,
        },
      });
    } catch (error) {
      console.error("[admin:gracePeriod] Error:", error);
      res.status(500).json({ error: "Failed to extend grace period" });
    }
  }

  // DELETE /api/v1/admin/users/:id
  static async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const user = await findUserByIdOrParam(req.params.id);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const isSuper = isSuperAdminUser(req);
      if (!isSuper && (user.role === "admin" || user.role === "superadmin" || user.isSystemRoot)) {
        res.status(403).json({
          error: "สิทธิ์ไม่เพียงพอ: Admin ทั่วไปไม่สามารถลบผู้ดูแลระบบคนอื่นได้",
        });
        return;
      }

      const beforeSnapshot = user.toObject();

      await User.deleteOne({ _id: user._id });
      await RefreshToken.deleteMany({ userId: user.userId });
      await ActiveLease.deleteMany({ userId: user.userId });

      cacheManager.delPrefix("user:");
      cacheManager.del("stats:dashboard");
      emitLicenseKickout(user.userId, { reason: "ACCOUNT_DELETED" });

      void recordAuditLog({
        actor: getActorFromReq(req),
        action: "USER_DELETE",
        category: "user",
        targetId: user.username,
        targetType: "User",
        summary: `ลบผู้ใช้งาน '${user.username}' (ID: ${user.userId})`,
        changes: { before: beforeSnapshot, after: null },
        isReversible: true,
      });

      res.json({ success: true, message: `User '${user.username}' deleted successfully` });
    } catch (error) {
      console.error("[admin:deleteUser] Error:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  }

  // POST /api/v1/admin/users/:id/reset-devices
  static async resetDevices(req: Request, res: Response): Promise<void> {
    try {
      const user = await findUserByIdOrParam(req.params.id);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const isSuper = isSuperAdminUser(req);
      if (!isSuper && (user.role === "admin" || user.role === "superadmin" || user.isSystemRoot)) {
        res.status(403).json({
          error: "สิทธิ์ไม่เพียงพอ: Admin ทั่วไปไม่สามารถล้างเครื่องของผู้ดูแลระบบคนอื่นได้",
        });
        return;
      }

      const sessionsBefore = await RefreshToken.find({ userId: user.userId }).lean();
      const result = await RefreshToken.deleteMany({ userId: user.userId });

      cacheManager.delPrefix("device:");
      emitLicenseKickout(user.userId, { reason: "DEVICES_RESET_BY_ADMIN" });

      void recordAuditLog({
        actor: getActorFromReq(req),
        action: "DEVICE_RESET",
        category: "security",
        targetId: user.username,
        targetType: "RefreshToken",
        summary: `ล้างประวัติเซสชันเข้าสู่ระบบของ '${user.username}' (${sessionsBefore.length} เซสชัน)`,
        changes: { before: sessionsBefore, after: [] },
        isReversible: true,
      });

      res.json({
        success: true,
        message: `Reset devices for user '${user.username}' successfully`,
        clearedSessions: result.deletedCount,
      });
    } catch (error) {
      console.error("[admin:resetDevices] Error:", error);
      res.status(500).json({ error: "Failed to reset devices" });
    }
  }

  // GET /api/v1/admin/leases
  static async getLeases(_req: Request, res: Response): Promise<void> {
    try {
      const now = new Date();
      const leases = await ActiveLease.find({ expiresAt: { $gt: now } }).sort({ expiresAt: -1 });

      const leasesWithUser = await Promise.all(
        leases.map(async (l) => {
          const u = await User.findOne({ userId: l.userId }).select("username role");
          return {
            ...l.toObject(),
            username: u?.username || `User #${l.userId}`,
            role: u?.role || "user",
          };
        })
      );

      res.json({ leases: leasesWithUser });
    } catch (error) {
      console.error("[admin:getLeases] Error:", error);
      res.status(500).json({ error: "Failed to retrieve active leases" });
    }
  }

  // GET /api/v1/admin/online-users
  static async getOnlineUsers(_req: Request, res: Response): Promise<void> {
    try {
      const users = await getOnlineUsersWithLeases();
      res.json({ success: true, users });
    } catch (error) {
      console.error("[admin:getOnlineUsers] Error:", error);
      res.status(500).json({ error: "Failed to retrieve online users" });
    }
  }

  // DELETE /api/v1/admin/leases/:leaseId
  static async releaseLease(req: Request, res: Response): Promise<void> {
    try {
      const lease = await ActiveLease.findOne({ leaseId: req.params.leaseId }).lean();
      const result = await ActiveLease.deleteOne({ leaseId: req.params.leaseId });

      cacheManager.del(`lease:${req.params.leaseId}`);
      cacheManager.del("stats:dashboard");

      if (lease) {
        void recordAuditLog({
          actor: getActorFromReq(req),
          action: "LEASE_RELEASE",
          category: "lease",
          targetId: req.params.leaseId,
          targetType: "ActiveLease",
          summary: `ปลดสิทธิ์จอ '${req.params.leaseId}' (โปรไฟล์: ${lease.profileFolderName})`,
          changes: { before: lease, after: null },
          isReversible: true,
        });
      }

      res.json({
        success: true,
        message: "Lease released successfully",
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error("[admin:releaseLease] Error:", error);
      res.status(500).json({ error: "Failed to release lease" });
    }
  }

  // GET /api/v1/admin/stats
  static async getStats(_req: Request, res: Response): Promise<void> {
    try {
      const statsData = await cacheManager.getOrSet(
        "stats:dashboard",
        async () => {
          const now = new Date();
          const totalUsers = await User.countDocuments();
          const activeUsers = await User.countDocuments({ status: "active" });
          const activeLeases = await ActiveLease.countDocuments({ expiresAt: { $gt: now } });
          const activeDevices = (await RefreshToken.distinct("device.hwid", { expiresAt: { $gt: now } })).length;

          return {
            totalUsers,
            activeUsers,
            activeLeases,
            activeDevices,
            mongoStatus: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
          };
        },
        4 // 4s TTL
      );

      res.json({
        ...statsData,
        serverUptime: Math.floor(process.uptime()),
        cacheMetrics: cacheManager.getMetrics(),
      });
    } catch (error) {
      console.error("[admin:getStats] Error:", error);
      res.status(500).json({ error: "Failed to retrieve stats" });
    }
  }

  // GET /api/v1/admin/captchas & /captcha-logs (Superadmin only)
  static async getCaptchas(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};
      if (req.query.type && (req.query.type === "slide" || req.query.type === "symbol")) {
        filter.captchaType = req.query.type;
      }
      if (req.query.userId && !isNaN(Number(req.query.userId))) {
        filter.userId = Number(req.query.userId);
      }
      if (req.query.status && typeof req.query.status === "string" && req.query.status !== "all") {
        filter.status = req.query.status;
      }
      if (req.query.success !== undefined) {
        filter["result.success"] = req.query.success === "true";
      }

      const total = await CaptchaLog.countDocuments(filter);
      const logs = await CaptchaLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const formattedLogs = logs.map((log) => {
        const filename = log.imageFilename;
        const placedFilename =
          log.imageWithPositionFilename ||
          (filename ? `${filename.replace(/\.[^.]+$/, "")}_placed.png` : null);

        return {
          ...log,
          appVersion: log.appVersion || null,
          aiVersion:
            log.aiVersion ||
            (log.captchaType === "slide" ? "ONNX YOLOv8" : "FastSAM + DINOv2"),
          imageUrl: filename ? `/api/v1/admin/captchas/${encodeURIComponent(filename)}/image` : null,
          imageWithPositionUrl: filename
            ? `/api/v1/admin/captchas/${encodeURIComponent(filename)}/image?overlay=true`
            : null,
          imageWithPositionFilename: placedFilename,
          imageBase64: log.imageBase64 || null,
        };
      });

      res.json({
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        logs: formattedLogs,
      });
    } catch (error) {
      console.error("[admin:getCaptchas] Error:", error);
      res.status(500).json({ error: "Failed to retrieve captcha logs" });
    }
  }

  // GET /api/v1/admin/captchas/:filename/image (Superadmin only)
  static async getCaptchaImage(req: Request, res: Response): Promise<void> {
    try {
      const safeFilename = path.basename(req.params.filename);
      const isOverlayRequested = req.query.overlay === "true" || req.query.mode === "placed";
      const captchasDir = path.join(process.cwd(), "storage", "captchas");

      if (isOverlayRequested) {
        // If filename ends with _placed.png, or user requested ?overlay=true:
        const placedFilename = safeFilename.includes("_placed")
          ? safeFilename
          : `${safeFilename.replace(/\.[^.]+$/, "")}_placed.png`;
        const placedPath = path.join(captchasDir, placedFilename);

        if (existsSync(placedPath)) {
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=86400");
          const buffer = await fs.readFile(placedPath);
          res.send(buffer);
          return;
        }

        // Dynamically composite on-the-fly if placed file doesn't exist yet
        const originalBaseFilename = safeFilename.replace(/_placed\.[^.]+$/, "");
        const originalPath = path.join(captchasDir, safeFilename);
        let baseBuffer: Buffer | null = null;

        if (existsSync(originalPath)) {
          baseBuffer = await fs.readFile(originalPath);
        } else {
          // Check matching original file in directory
          const files = existsSync(captchasDir) ? await fs.readdir(captchasDir) : [];
          const matchFile = files.find((f) => f.startsWith(originalBaseFilename) && !f.includes("_placed"));
          if (matchFile) {
            baseBuffer = await fs.readFile(path.join(captchasDir, matchFile));
          }
        }

        // Search log in MongoDB
        const log = await CaptchaLog.findOne({
          $or: [
            { imageFilename: safeFilename },
            { imageWithPositionFilename: safeFilename },
            { imageFilename: { $regex: new RegExp(`^${originalBaseFilename.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`) } },
          ],
        });

        if (!baseBuffer && log?.imageBase64) {
          const match = log.imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
          if (match && match[2]) {
            baseBuffer = Buffer.from(match[2], "base64");
          }
        }

        if (baseBuffer && log) {
          try {
            const overlaid = await renderOverlayOnImage(baseBuffer, {
              captchaType: log.captchaType,
              status: log.status,
              result: log.result,
              imageWidth: log.imageWidth,
              imageHeight: log.imageHeight,
            });
            // Cache on disk for subsequent requests
            void fs.writeFile(placedPath, overlaid).catch(() => {});
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.send(overlaid);
            return;
          } catch (e) {
            console.warn("[admin:getCaptchaImage] Failed to generate dynamic overlay:", e);
          }
        }
      }

      const filePath = path.join(captchasDir, safeFilename);
      if (existsSync(filePath)) {
        const ext = path.extname(safeFilename).toLowerCase();
        const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        const buffer = await fs.readFile(filePath);
        res.send(buffer);
        return;
      }

      // Fallback: load directly from MongoDB if file was purged or on ephemeral storage
      const log = await CaptchaLog.findOne({ imageFilename: safeFilename });
      if (log?.imageBase64) {
        const match = log.imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (match && match[2]) {
          const contentType = match[1] || "image/png";
          const buffer = Buffer.from(match[2], "base64");
          res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.send(buffer);
          return;
        }
      }

      res.status(404).json({ error: "Captcha image not found" });
    } catch (error) {
      console.error("[admin:getCaptchaImage] Error:", error);
      res.status(500).json({ error: "Failed to load captcha image" });
    }
  }

  // GET /api/v1/admin/logs (Superadmin only)
  static async getLogs(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};

      if (req.query.category && typeof req.query.category === "string") {
        filter.category = req.query.category;
      }

      if (req.query.action && typeof req.query.action === "string") {
        filter.action = req.query.action;
      }

      if (req.query.reverted !== undefined) {
        filter.isReverted = req.query.reverted === "true";
      }

      if (req.query.reversible !== undefined) {
        filter.isReversible = req.query.reversible === "true";
      }

      if (req.query.search && typeof req.query.search === "string") {
        const q = req.query.search.trim();
        filter.$or = [
          { targetId: { $regex: q, $options: "i" } },
          { summary: { $regex: q, $options: "i" } },
          { "actor.username": { $regex: q, $options: "i" } },
        ];
      }

      const total = await AuditLog.countDocuments(filter);
      const logs = await AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      res.json({
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        logs,
      });
    } catch (error) {
      console.error("[admin:getLogs] Error:", error);
      res.status(500).json({ error: "Failed to retrieve audit logs" });
    }
  }

  // POST /api/v1/admin/logs/:id/revert (Superadmin only)
  static async revertLog(req: Request, res: Response): Promise<void> {
    try {
      const actor = getActorFromReq(req);
      const result = await executeRevert(req.params.id, actor);
      res.json(result);
    } catch (error) {
      console.error("[admin:revertLog] Error:", error);
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  // GET /api/v1/admin/cache-stats (Superadmin only)
  static async getCacheStats(_req: Request, res: Response): Promise<void> {
    try {
      res.json({
        success: true,
        metrics: cacheManager.getMetrics(),
      });
    } catch (error) {
      console.error("[admin:cacheStats] Error:", error);
      res.status(500).json({ error: "Failed to retrieve cache stats" });
    }
  }

  // POST /api/v1/admin/releases/upload (Superadmin only)
  static async uploadRelease(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No installer file uploaded" });
        return;
      }

      const filePath = req.file.path;
      const originalName = req.file.originalname;
      const detectedVersion = await detectFileVersion(filePath, originalName);
      const fileHash = await calculateFileSha256(filePath);
      const downloadUrl = `/storage/releases/${req.file.filename}`;

      res.json({
        success: true,
        fileName: req.file.filename,
        originalName,
        fileSize: req.file.size,
        fileHash,
        detectedVersion,
        downloadUrl,
      });
    } catch (error) {
      console.error("[admin:uploadRelease] Error:", error);
      res.status(500).json({ error: "Failed to process installer file upload" });
    }
  }

  // POST /api/v1/admin/releases/broadcast (Superadmin only)
  static async broadcastRelease(req: Request, res: Response): Promise<void> {
    try {
      const {
        version,
        minRequiredVersion,
        title,
        description,
        fileName,
        fileSize,
        fileHash,
        downloadUrl,
        isMandatory,
      } = req.body ?? {};

      if (!version || !fileName || !downloadUrl) {
        res.status(400).json({ error: "version, fileName, and downloadUrl are required" });
        return;
      }

      const actor = getActorFromReq(req);

      // Mark older releases as not latest
      await AppRelease.updateMany({}, { $set: { isLatest: false } });

      // Create new release record
      const release = await AppRelease.create({
        version: String(version).trim(),
        minRequiredVersion: String(minRequiredVersion || "1.0.0").trim(),
        title: title ? String(title).trim() : `FlowUltraTech v${version}`,
        description: description ? String(description).trim() : "",
        fileName: String(fileName),
        fileSize: Number(fileSize) || 0,
        fileHash: String(fileHash || ""),
        downloadUrl: String(downloadUrl),
        isMandatory: Boolean(isMandatory),
        isLatest: true,
        publishedBy: {
          userId: actor.userId,
          username: actor.username,
        },
        publishedAt: new Date(),
      });

      // Broadcast update to all connected clients via Socket.io
      emitAppUpdate({
        release: {
          version: release.version,
          minRequiredVersion: release.minRequiredVersion,
          title: release.title,
          description: release.description,
          downloadUrl: release.downloadUrl,
          isMandatory: release.isMandatory,
          fileSize: release.fileSize,
          fileHash: release.fileHash,
          publishedAt: release.publishedAt.toISOString(),
        },
      });

      // Audit Log
      await recordAuditLog({
        actor,
        action: "APP_RELEASE",
        category: "system",
        targetId: release.version,
        targetType: "AppRelease",
        summary: `Superadmin ${actor.username} broadcasted app update v${release.version}`,
        metadata: {
          version: release.version,
          minRequiredVersion: release.minRequiredVersion,
          downloadUrl: release.downloadUrl,
          isMandatory: release.isMandatory,
        },
      });

      res.json({
        success: true,
        message: `Successfully broadcasted app update v${release.version}`,
        release,
      });
    } catch (error) {
      console.error("[admin:broadcastRelease] Error:", error);
      res.status(500).json({ error: "Failed to broadcast app release" });
    }
  }

  // GET /api/v1/admin/releases (Superadmin only)
  static async getReleases(_req: Request, res: Response): Promise<void> {
    try {
      const releases = await AppRelease.find().sort({ publishedAt: -1 }).limit(50);
      res.json({
        success: true,
        releases,
      });
    } catch (error) {
      console.error("[admin:getReleases] Error:", error);
      res.status(500).json({ error: "Failed to retrieve releases" });
    }
  }

  // GET /api/v1/app/latest-release (Public / Client)
  static async getLatestRelease(_req: Request, res: Response): Promise<void> {
    try {
      let latest: any = null;
      if (mongoose.connection.readyState === 1) {
        try {
          latest = await AppRelease.findOne({ isLatest: true }).sort({ publishedAt: -1 }).lean();
        } catch {}
      }

      if (latest) {
        res.json({
          success: true,
          release: latest,
        });
        return;
      }

      // If DB has no releases marked as latest, check storage/releases
      const releasesDir = path.join(process.cwd(), "storage", "releases");
      if (existsSync(releasesDir)) {
        const files = readdirSync(releasesDir).filter(f => f.endsWith(".exe"));
        if (files.length > 0) {
          files.sort((a, b) => {
            const vA = extractVersionFromFilename(a) || "0.0.0";
            const vB = extractVersionFromFilename(b) || "0.0.0";
            return compareSemver(vB, vA);
          });
          const highestFile = files[0];
          const ver = extractVersionFromFilename(highestFile) || "1.0.0";
          let size = 54341405;
          try { size = statSync(path.join(releasesDir, highestFile)).size; } catch {}
          res.json({
            success: true,
            release: {
              version: ver,
              minRequiredVersion: "0.1.0",
              title: `FlowUltraTech v${ver}`,
              description: `Multi-Instance & Automation for TikTok LIVE Studio v${ver}`,
              fileName: highestFile,
              fileSize: size,
              fileHash: "",
              downloadUrl: `/api/v1/app/download?version=${ver}`,
              isMandatory: false,
              isLatest: true,
              downloadsCount: 168,
              publishedAt: new Date().toISOString(),
            },
          });
          return;
        }
      }

      res.json({
        success: true,
        release: {
          version: "1.0.0",
          minRequiredVersion: "0.1.0",
          title: "FlowUltraTech v1.0.0",
          description: "Multi-Instance & Automation for TikTok LIVE Studio",
          fileName: "FlowUltraTech_Setup_v1.0.0.exe",
          fileSize: 54341405,
          fileHash: "38E80B3D1D2B8D78BBF1A8B02CD64E5A844DC423C3C6C8ECD2C76856DAA492CF",
          downloadUrl: "/api/v1/app/download?version=1.0.0",
          isMandatory: false,
          isLatest: true,
          downloadsCount: 168,
          publishedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error("[admin:getLatestRelease] Error:", error);
      res.status(500).json({ error: "Failed to retrieve latest release" });
    }
  }

  // GET /api/v1/app/releases or /api/v1/app/versions (Public)
  static async getPublicReleases(_req: Request, res: Response): Promise<void> {
    try {
      let releases: any[] = [];
      if (mongoose.connection.readyState === 1) {
        try {
          releases = (await AppRelease.find().sort({ publishedAt: -1 }).lean()) as any[];
        } catch {}
      }

      // If DB has no releases, auto-discover files from storage/releases
      if (releases.length === 0) {
        const releasesDir = path.join(process.cwd(), "storage", "releases");
        if (existsSync(releasesDir)) {
          const files = readdirSync(releasesDir).filter(f => f.endsWith(".exe"));
          const discovered: any[] = [];
          for (const file of files) {
            const ver = extractVersionFromFilename(file) || "0.1.0";
            const fullPath = path.join(releasesDir, file);
            let size = 0;
            try {
              size = statSync(fullPath).size;
            } catch {}
            discovered.push({
              version: ver,
              minRequiredVersion: "0.1.0",
              title: `FlowUltraTech v${ver}`,
              description: `รุ่นติดตั้ง FlowUltraTech v${ver}`,
              fileName: file,
              fileSize: size,
              fileHash: "",
              downloadUrl: `/api/v1/app/download?version=${ver}`,
              isMandatory: false,
              isLatest: false,
              downloadsCount: 0,
              publishedAt: new Date(),
            });
          }
          releases = discovered;
        }
      }

      if (releases.length === 0) {
        releases = [{
          version: "1.0.0",
          minRequiredVersion: "0.1.0",
          title: "FlowUltraTech v1.0.0",
          description: "Multi-Instance & Automation for TikTok LIVE Studio",
          fileName: "FlowUltraTech_Setup_v1.0.0.exe",
          fileSize: 54341405,
          fileHash: "",
          downloadUrl: "/api/v1/app/download?version=1.0.0",
          isMandatory: false,
          isLatest: true,
          downloadsCount: 168,
          publishedAt: new Date(),
        }];
      }

      // Sort releases by semver descending
      releases.sort((a, b) => compareSemver(b.version, a.version));

      // Determine latest release & minimum required version
      const latestRel = releases.find(r => r.isLatest) || releases[0];
      const latestVersion = latestRel.version;
      const minRequiredVersion = latestRel.minRequiredVersion || "0.1.0";

      // Filter: ตั้งแต่ ver ที่บังคับ -> ver ล่าสุด
      const filteredReleases = releases.filter(r => {
        return compareSemver(r.version, minRequiredVersion) >= 0 &&
               compareSemver(r.version, latestVersion) <= 0;
      });

      res.json({
        success: true,
        latestVersion,
        minRequiredVersion,
        totalCount: filteredReleases.length,
        releases: filteredReleases.map(r => ({
          version: r.version,
          minRequiredVersion: r.minRequiredVersion || minRequiredVersion,
          title: r.title || `FlowUltraTech v${r.version}`,
          description: r.description || "",
          fileName: r.fileName,
          fileSize: r.fileSize,
          fileHash: r.fileHash,
          downloadUrl: `/api/v1/app/download?version=${r.version}`,
          isMandatory: r.isMandatory || false,
          isLatest: r.version === latestVersion,
          isMinRequired: r.version === minRequiredVersion,
          downloadsCount: r.downloadsCount || 0,
          publishedAt: r.publishedAt,
        })),
      });
    } catch (error) {
      console.error("[admin:getPublicReleases] Error:", error);
      res.status(500).json({ error: "Failed to retrieve public releases" });
    }
  }

  // GET /api/v1/app/download (Public Direct Installer Download)
  static async downloadInstaller(req: Request, res: Response): Promise<void> {
    try {
      const requestedVersion = (req.query.version || req.query.v || req.params.version || "") as string;
      let fileName = "";
      let filePath = "";

      if (requestedVersion) {
        const cleanV = String(requestedVersion).replace(/^v/i, "").trim();
        if (mongoose.connection.readyState === 1) {
          try {
            const targetRelease = await AppRelease.findOne({
              $or: [{ version: cleanV }, { version: `v${cleanV}` }]
            }).lean();

            if (targetRelease?.fileName) {
              fileName = targetRelease.fileName;
              filePath = path.join(process.cwd(), "storage", "releases", fileName);
            }
          } catch {}
        }

        if (!filePath || !existsSync(filePath)) {
          const releasesDir = path.join(process.cwd(), "storage", "releases");
          if (existsSync(releasesDir)) {
            const match = readdirSync(releasesDir).find(f => {
              const fVer = extractVersionFromFilename(f);
              return fVer === cleanV || f.toLowerCase().includes(`v${cleanV}.exe`) || f.toLowerCase().includes(`_${cleanV}.exe`);
            });
            if (match) {
              fileName = match;
              filePath = path.join(releasesDir, match);
            }
          }
        }
      }

      // If no specific version requested or not found, fallback to latest
      if (!filePath || !existsSync(filePath)) {
        if (mongoose.connection.readyState === 1) {
          try {
            const latest = await AppRelease.findOne({ isLatest: true }).sort({ publishedAt: -1 }).lean();
            if (latest?.fileName) {
              fileName = latest.fileName;
              filePath = path.join(process.cwd(), "storage", "releases", fileName);
            }
          } catch {}
        }
      }

      if (!filePath || !existsSync(filePath)) {
        const releasesDir = path.join(process.cwd(), "storage", "releases");
        if (existsSync(releasesDir)) {
          const files = readdirSync(releasesDir).filter(f => f.endsWith(".exe"));
          if (files.length > 0) {
            files.sort((a, b) => {
              const vA = extractVersionFromFilename(a) || "0.0.0";
              const vB = extractVersionFromFilename(b) || "0.0.0";
              return compareSemver(vB, vA);
            });
            fileName = files[0];
            filePath = path.join(releasesDir, fileName);
          }
        }
      }

      if (!existsSync(filePath)) {
        res.status(404).json({ error: "Installer file not found on server" });
        return;
      }

      // Asynchronously increment download counter
      if (mongoose.connection.readyState === 1) {
        void AppRelease.updateOne(
          { fileName },
          { $inc: { downloadsCount: 1 } }
        ).catch(() => {});
      }

      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Type", "application/vnd.microsoft.portable-executable");
      res.download(filePath, fileName);
    } catch (error) {
      console.error("[admin:downloadInstaller] Error:", error);
      res.status(500).json({ error: "Failed to download installer" });
    }
  }
}

