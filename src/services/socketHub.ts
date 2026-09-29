import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../middlewares/auth.js";
import { ActiveLease } from "../models/ActiveLease.js";
import { User } from "../models/User.js";

export interface AuthenticatedUser {
  userId: number;
  username: string;
  role: "superadmin" | "admin" | "user";
  isSystemRoot?: boolean;
}

export interface ClientInstanceInfo {
  name: string;
  accountName?: string;
  profileFolderName: string;
  cdpPort: number;
  status: string; // 'Running' | 'Stopped' | 'Starting' | 'Error'
  isTikTokRunning?: boolean;
  processId?: number;
  startedAt?: string;
  uptimeSeconds?: number;
  proxy?: string;
  isLoggedIn: boolean;
  channelName?: string;
  channelHandle?: string;
  channelAvatar?: string;
  activeLeaseId?: string;
  captcha?: {
    hasAlert: boolean;
    isSolving: boolean;
    typeDescription: string;
    countdown: string;
    lastDetectedTime?: string;
    count: number;
  };
}

export interface ConnectedClientSession {
  socketId: string;
  userId: number;
  username: string;
  role: "superadmin" | "admin" | "user";
  clientIp?: string;
  connectedAt: string;
  lastHeartbeat: string;
  appVersion?: string;
  hwid?: string;
  hostname?: string;
  isProgramOpen?: boolean;
  runningCount?: number;
  totalCount?: number;
  instances: ClientInstanceInfo[];
  activeLeases?: unknown[];
  isBackoffice?: boolean;
}

const onlineSessions = new Map<string, ConnectedClientSession>();
let ioInstance: SocketIOServer | null = null;
let updateDebounceTimer: NodeJS.Timeout | null = null;
const pendingLogRequests = new Map<string, (res: Record<string, unknown>) => void>();

export const initSocketHub = (httpServer: HttpServer): SocketIOServer => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
    transports: ["websocket", "polling"],
  });

  io.use((socket: Socket, next) => {
    try {
      const authHeader = socket.handshake.headers.authorization;
      const bearerToken =
        typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "").trim() : null;
      const authToken = socket.handshake.auth?.token;
      const queryToken = socket.handshake.query?.token;
      const token = authToken || bearerToken || (typeof queryToken === "string" ? queryToken : null);

      if (!token || typeof token !== "string") {
        return next(new Error("Authentication token required"));
      }

      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, unknown>;
      if (!decoded || (decoded.id === undefined && decoded.userId === undefined)) {
        return next(new Error("Invalid token payload"));
      }

      const userId = Number(decoded.id ?? decoded.userId);
      const user: AuthenticatedUser = {
        userId,
        username: String(decoded.username || "unknown"),
        role: (decoded.role as "superadmin" | "admin" | "user") || "user",
        isSystemRoot: Boolean(decoded.isSystemRoot),
      };

      socket.data.user = user;
      next();
    } catch (err) {
      console.warn(`[socketHub] Handshake auth error:`, (err as Error).message);
      next(new Error("Authentication failed: " + (err as Error).message));
    }
  });

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user as AuthenticatedUser;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    const rawClientType =
      socket.handshake.auth?.clientType ||
      socket.handshake.query?.clientType ||
      socket.handshake.headers["x-client-type"];
    const referer = String(socket.handshake.headers["referer"] || "");
    const userAgent = String(socket.handshake.headers["user-agent"] || "");
    const isBrowser = userAgent.includes("Mozilla/") || userAgent.includes("Chrome/") || userAgent.includes("Safari/");
    const isBackoffice =
      rawClientType === "backoffice" ||
      referer.includes("/backoffice") ||
      referer.includes("/admin") ||
      socket.handshake.auth?.isBackoffice === true ||
      isBrowser;

    // Join specific user room for direct push
    const userRoom = `user_${user.userId}`;
    socket.join(userRoom);

    // If admin or superadmin, join admin room for live monitoring
    if (user.role === "admin" || user.role === "superadmin" || user.isSystemRoot) {
      socket.join("admin_room");
      console.log(
        `[socketHub] Admin connected: ${user.username} (userId: ${user.userId}, isBackoffice: ${isBackoffice}) joined ${userRoom} and admin_room`
      );
    } else {
      console.log(`[socketHub] User connected: ${user.username} (userId: ${user.userId}) joined ${userRoom}`);
    }

    const rawIp =
      (socket.handshake.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      socket.handshake.address ||
      "";
    const clientIp = rawIp.replace(/^.*:/, "");

    if (!isBackoffice && rawClientType === "desktop") {
      const session: ConnectedClientSession = {
        socketId: socket.id,
        userId: user.userId,
        username: user.username,
        role: user.role,
        clientIp,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        instances: [],
      };
      onlineSessions.set(socket.id, session);
      emitOnlineUsersUpdated();
    }

    socket.emit("connected", {
      success: true,
      userId: user.userId,
      username: user.username,
      role: user.role,
      serverTime: new Date().toISOString(),
    });

    socket.on("ping:check", (cb) => {
      if (typeof cb === "function") cb({ time: Date.now() });
    });

    // Socket-based Slot Keep-Alive Heartbeat (sub-millisecond RTT, replaces HTTP polling    // Realtime Slot Heartbeat (Watchdog Keep-Alive with Ultra-low latency <2ms RTT)
    socket.on(
      "slot:heartbeat",
      async (data: { leaseId?: string; hwid?: string }, callback?: (res: Record<string, unknown>) => void) => {
        const startTime = performance.now();
        try {
          const leaseId = data?.leaseId ? String(data.leaseId).trim() : "";
          if (!leaseId) {
            if (typeof callback === "function") callback({ success: false, error: "leaseId is required" });
            return;
          }

          let lease = await ActiveLease.findOne({ leaseId });
          const now = new Date();
          const LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes

          // Self-Healing: If lease was evicted during server reload, auto-heal using socket authenticated user
          if (!lease && user) {
            try {
              const leaseUser = await User.findOne({ userId: user.userId });
              if (leaseUser && leaseUser.status === "active") {
                const maxAccounts = leaseUser.isSystemRoot ? 9999 : (leaseUser.license?.maxTiktokAccounts ?? 1);
                const activeCount = await ActiveLease.countDocuments({
                  userId: user.userId,
                  expiresAt: { $gt: now },
                });
                if (activeCount < maxAccounts) {
                  lease = await ActiveLease.create({
                    leaseId,
                    userId: user.userId,
                    profileFolderName: "default",
                    hwid: data?.hwid ? String(data.hwid).trim() : "",
                    expiresAt: new Date(Date.now() + LEASE_TTL_MS),
                  });
                  console.log(`[socketHub:heartbeat] 🔄 Restored evicted lease ${leaseId} for user ${user.userId}`);
                }
              }
            } catch {
              // fallback to 404
            }
          }

          if (!lease) {
            const elapsed = (performance.now() - startTime).toFixed(1);
            console.warn(`[socketHub:heartbeat] ✖ Rejected (404 SLOT_REVOKED) for lease ${leaseId} in ${elapsed}ms`);
            if (typeof callback === "function") {
              callback({
                success: false,
                statusCode: 404,
                error: "SLOT_REVOKED",
                isRevoked: true,
                message: "โควต้าจอของคุณถูกปรับลดลง หรือสิทธิ์จอนี้ถูกเพิกถอนแล้ว",
              });
            }
            return;
          }

          if (lease.expiresAt < now) {
            const elapsed = (performance.now() - startTime).toFixed(1);
            console.warn(`[socketHub:heartbeat] ✖ Rejected (403 LEASE_EXPIRED) for lease ${leaseId} in ${elapsed}ms`);
            if (typeof callback === "function") {
              callback({
                success: false,
                statusCode: 403,
                error: "LEASE_EXPIRED",
                message: "Lease หมดอายุแล้ว กรุณาขอสิทธิ์ใหม่อีกครั้ง",
              });
            }
            return;
          }

          // Verify user license validity and status
          const leaseUser = await User.findOne({ userId: lease.userId });
          if (!leaseUser || leaseUser.status !== "active") {
            await ActiveLease.deleteOne({ _id: lease._id });
            emitLeaseChanged({
              action: "revoked",
              lease: { leaseId: lease.leaseId, userId: lease.userId },
            });
            const elapsed = (performance.now() - startTime).toFixed(1);
            console.warn(`[socketHub:heartbeat] ✖ User inactive for lease ${leaseId} in ${elapsed}ms`);
            if (typeof callback === "function") {
              callback({
                success: false,
                statusCode: 403,
                error: "ACCOUNT_INACTIVE",
                message: "บัญชีผู้ใช้ถูกระงับการใช้งานหรือไม่อนุญาต",
              });
            }
            return;
          }

          if (
            !leaseUser.isSystemRoot &&
            leaseUser.license?.expiredAt &&
            now > new Date(leaseUser.license.expiredAt)
          ) {
            await ActiveLease.deleteOne({ _id: lease._id });
            emitLeaseChanged({
              action: "revoked",
              lease: { leaseId: lease.leaseId, userId: lease.userId },
            });
            const elapsed = (performance.now() - startTime).toFixed(1);
            console.warn(`[socketHub:heartbeat] ✖ License expired for lease ${leaseId} in ${elapsed}ms`);
            if (typeof callback === "function") {
              callback({
                success: false,
                statusCode: 403,
                error: "LICENSE_EXPIRED",
                isExpired: true,
                message: "ใบอนุญาตใช้งานของคุณหมดอายุแล้ว",
              });
            }
            return;
          }

          // Verify quota
          const maxAccounts = leaseUser.isSystemRoot
            ? 9999
            : leaseUser.license?.maxTiktokAccounts ?? 1;
          const activeLeases = await ActiveLease.find({
            userId: leaseUser.userId,
            expiresAt: { $gt: now },
          }).sort({ createdAt: 1 });

          const allowedLeaseIds = new Set(activeLeases.slice(0, maxAccounts).map((l) => l.leaseId));
          if (!allowedLeaseIds.has(lease.leaseId)) {
            await ActiveLease.deleteOne({ _id: lease._id });
            emitLeaseChanged({
              action: "revoked",
              lease: { leaseId: lease.leaseId, userId: lease.userId },
            });
            const elapsed = (performance.now() - startTime).toFixed(1);
            console.warn(`[socketHub:heartbeat] ✖ Quota exceeded for lease ${leaseId} (Allowed: ${maxAccounts}) in ${elapsed}ms`);
            if (typeof callback === "function") {
              callback({
                success: false,
                statusCode: 403,
                error: "SLOT_REVOKED",
                isRevoked: true,
                message: `โควต้าจอของคุณถูกปรับลดลงเหลือ ${maxAccounts} จอ สิทธิ์จอนี้จึงถูกเพิกถอน`,
              });
            }
            return;
          }

          // Extend lease by 10 minutes to survive server redeploy and maintenance
          lease.expiresAt = new Date(Date.now() + LEASE_TTL_MS);
          await lease.save();

          const elapsed = (performance.now() - startTime).toFixed(1);
          console.log(
            `[socketHub:heartbeat] ✔ Socket Heartbeat SUCCESS for lease ${lease.leaseId} (User: ${lease.userId}, Profile: ${lease.profileFolderName}) -> Extended TTL to ${lease.expiresAt.toISOString()} (took ${elapsed}ms)`
          );

          if (typeof callback === "function") {
            callback({
              success: true,
              statusCode: 200,
              leaseId: lease.leaseId,
              expiresAt: lease.expiresAt.toISOString(),
              message: "Keep-Alive Confirmed (Socket.io)",
            });
          }
        } catch (err) {
          const elapsed = (performance.now() - startTime).toFixed(1);
          console.error(`[socketHub:heartbeat] Error in ${elapsed}ms:`, err);
          if (typeof callback === "function") {
            callback({ success: false, statusCode: 500, error: "Internal server error" });
          }
        }
      }
    );

    // Realtime Instances Report from Client
    socket.on(
      "client:instances_report",
      (data: {
        appVersion?: string;
        hwid?: string;
        hostname?: string;
        isProgramOpen?: boolean;
        runningCount?: number;
        totalCount?: number;
        instances?: ClientInstanceInfo[];
      }) => {
        let sess = onlineSessions.get(socket.id);
        if (!sess) {
          sess = {
            socketId: socket.id,
            userId: user.userId,
            username: user.username,
            role: user.role,
            clientIp,
            connectedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            instances: [],
          };
          onlineSessions.set(socket.id, sess);
        }
        sess.lastHeartbeat = new Date().toISOString();
        sess.isProgramOpen = true;
        if (data?.appVersion) sess.appVersion = String(data.appVersion);
        if (data?.hwid) sess.hwid = String(data.hwid);
        if (data?.hostname) sess.hostname = String(data.hostname);
        if (typeof data?.runningCount === "number") sess.runningCount = data.runningCount;
        if (typeof data?.totalCount === "number") sess.totalCount = data.totalCount;
        if (Array.isArray(data?.instances)) {
          sess.instances = data.instances;
          if (typeof sess.runningCount !== "number") {
            sess.runningCount = data.instances.filter(
              (i) => i.isTikTokRunning || i.status?.toLowerCase() === "running"
            ).length;
          }
          sess.totalCount = data.instances.length;
        }
        console.log(
          `[socketHub] Telemetry report from ${user.username} (${socket.id}): ${sess.runningCount ?? 0}/${sess.totalCount ?? 0} running, HWID: ${sess.hwid ?? "N/A"}`
        );
        emitOnlineUsersUpdated();
      }
    );

    // Admin query for online users
    socket.on(
      "admin:get_online_users",
      async (callback?: (res: { success: boolean; users: ConnectedClientSession[] }) => void) => {
        if (typeof callback === "function") {
          const list = await getOnlineUsersWithLeases();
          callback({ success: true, users: list });
        }
      }
    );

    // Admin request to fetch remote instance logs from client
    socket.on(
      "admin:fetch_instance_logs",
      async (
        data: {
          targetUserId: number;
          targetSocketId?: string;
          profileFolderName?: string;
          accountName?: string;
          cdpPort?: number;
          maxLines?: number;
        },
        callback?: (res: Record<string, unknown>) => void
      ) => {
        if (user.role !== "admin" && user.role !== "superadmin" && !user.isSystemRoot) {
          if (typeof callback === "function") callback({ success: false, error: "Unauthorized" });
          return;
        }

        const targetUserId = Number(data?.targetUserId);
        const targetSocketId = data?.targetSocketId ? String(data.targetSocketId) : null;
        const targetRoom = targetSocketId || `user_${targetUserId}`;
        const requestId = `log_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        const reqPayload = {
          requestId,
          profileFolderName: data?.profileFolderName || "",
          accountName: data?.accountName || "",
          cdpPort: data?.cdpPort || 0,
          maxLines: data?.maxLines || 2000,
        };

        if (!ioInstance) {
          if (typeof callback === "function") callback({ success: false, error: "Server socket not ready" });
          return;
        }

        console.log(
          `[socketHub] Admin ${user.username} requesting logs for User ${targetUserId} (${reqPayload.profileFolderName}) in ${targetRoom}`
        );

        let hasResponded = false;
        const respond = (result: Record<string, unknown>) => {
          if (hasResponded) return;
          hasResponded = true;
          pendingLogRequests.delete(requestId);
          if (typeof callback === "function") callback(result);
        };

        pendingLogRequests.set(requestId, respond);

        const timeoutHandle = setTimeout(() => {
          respond({
            success: false,
            error: "Client response timed out (15s). The client may be busy or offline.",
          });
        }, 15000);

        try {
          ioInstance.to(targetRoom).emit("cmd:get_instance_logs", reqPayload);
        } catch (err) {
          clearTimeout(timeoutHandle);
          respond({ success: false, error: (err as Error).message });
        }
      }
    );

    // Relay log response from client to admin_room and resolve pending request
    socket.on("client:instance_logs_response", (data: unknown) => {
      const respData = data as Record<string, unknown>;
      const reqId = String(respData?.requestId || "");
      if (reqId && pendingLogRequests.has(reqId)) {
        const handler = pendingLogRequests.get(reqId);
        if (handler) handler(respData);
      }
      ioInstance?.to("admin_room").emit("admin:instance_logs_received", data);
    });

    socket.on("disconnect", () => {
      onlineSessions.delete(socket.id);
      emitOnlineUsersUpdated();
    });
  });

  ioInstance = io;
  return io;
};

export const getSocketIO = (): SocketIOServer | null => ioInstance;

// Helper emitters:
export const emitQuotaReduced = (
  userId: number,
  payload: { newMax: number; revokedLeaseIds: string[] }
): void => {
  if (!ioInstance) return;
  // Send instant push to user room (<100ms)
  ioInstance.to(`user_${userId}`).emit("quota:reduced", {
    userId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
  // Notify admin room
  ioInstance.to("admin_room").emit("user:quota_reduced", {
    userId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitLicenseKickout = (
  userId: number,
  payload: { reason: string; expiredAt?: Date | string }
): void => {
  if (!ioInstance) return;
  ioInstance.to(`user_${userId}`).emit("license:kickout", {
    userId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
  ioInstance.to("admin_room").emit("user:kickout", {
    userId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitLicenseUpdated = (
  userId: number,
  payload: {
    expiredAt?: Date | string;
    maxTiktokAccounts?: number;
    status?: string;
    plan?: string;
  }
): void => {
  if (!ioInstance) return;
  ioInstance.to(`user_${userId}`).emit("license:updated", {
    userId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
  ioInstance.to("admin_room").emit("user:updated", {
    userId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitLeaseChanged = (payload: {
  action: "acquired" | "released" | "revoked";
  lease: unknown;
}): void => {
  if (!ioInstance) return;
  ioInstance.to("admin_room").emit("lease:changed", {
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitCaptchaLogUpdate = (payload: {
  log: unknown;
  action: "created" | "verified";
}): void => {
  if (!ioInstance) return;
  ioInstance.to("admin_room").emit("captcha:status_changed", {
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitSecurityAlert = (payload: { alert: unknown }): void => {
  if (!ioInstance) return;
  ioInstance.to("admin_room").emit("security:alert", {
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitAuditLogged = (payload: { log: unknown }): void => {
  if (!ioInstance) return;
  ioInstance.to("admin_room").emit("audit:logged", {
    ...payload,
    timestamp: new Date().toISOString(),
  });
};

export const emitAppUpdate = (payload: {
  release: {
    version: string;
    minRequiredVersion: string;
    title?: string;
    description: string;
    downloadUrl: string;
    isMandatory: boolean;
    fileSize?: number;
    fileHash?: string;
    publishedAt: string;
  };
}): void => {
  if (!ioInstance) return;
  // Broadcast to all connected clients
  ioInstance.emit("app:update", {
    ...payload,
    timestamp: new Date().toISOString(),
  });
  console.log(`[socketHub] Broadcasted app update v${payload.release.version} to all connected clients.`);
};

export const getOnlineUsersWithLeases = async (): Promise<ConnectedClientSession[]> => {
  try {
    const activeLeases = await ActiveLease.find({ expiresAt: { $gt: new Date() } }).lean();
    const sessions = Array.from(onlineSessions.values()).filter((sess) => !sess.isBackoffice);

    const leasesByUser = new Map<number, unknown[]>();
    for (const lease of activeLeases) {
      const uId = lease.userId;
      if (!leasesByUser.has(uId)) leasesByUser.set(uId, []);
      leasesByUser.get(uId)!.push(lease);
    }

    return sessions.map((sess) => ({
      ...sess,
      activeLeases: leasesByUser.get(sess.userId) || [],
    }));
  } catch (err) {
    console.error("[socketHub:getOnlineUsersWithLeases] Error:", err);
    return Array.from(onlineSessions.values());
  }
};

export const emitOnlineUsersUpdated = (): void => {
  if (!ioInstance) return;
  if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
  updateDebounceTimer = setTimeout(async () => {
    try {
      const list = await getOnlineUsersWithLeases();
      ioInstance?.to("admin_room").emit("admin:online_users_updated", { users: list });
    } catch (e) {
      console.error("[socketHub:emitOnlineUsersUpdated] Error:", e);
    }
  }, 200);
};

