import express, { type Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { authenticateToken, requireAdmin, requireSuperAdmin } from "../middlewares/auth.js";
import { protectRoot } from "../middlewares/protectRoot.js";
import { AdminController } from "../controllers/adminController.js";

export const adminRouter: Router = express.Router();

const releasesDir = path.join(process.cwd(), "storage", "releases");
if (!fs.existsSync(releasesDir)) {
  fs.mkdirSync(releasesDir, { recursive: true });
}

const releaseStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, releasesDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});

const uploadRelease = multer({
  storage: releaseStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max installer size
});

adminRouter.use(authenticateToken);
adminRouter.use(requireAdmin);

// User Management
adminRouter.get("/users", AdminController.getUsers);
adminRouter.post("/users", AdminController.createUser);
adminRouter.get("/users/:id", AdminController.getUserById);
adminRouter.put("/users/:id", protectRoot, AdminController.updateUser);
adminRouter.post("/users/:id/grace-period", AdminController.grantGracePeriod);
adminRouter.delete("/users/:id", protectRoot, AdminController.deleteUser);
adminRouter.post("/users/:id/reset-devices", AdminController.resetDevices);

// Leases, Online Users & Stats
adminRouter.get("/leases", AdminController.getLeases);
adminRouter.get("/online-users", AdminController.getOnlineUsers);
adminRouter.delete("/leases/:leaseId", AdminController.releaseLease);
adminRouter.get("/stats", AdminController.getStats);

// Captcha Logs (Superadmin)
adminRouter.get(["/captchas", "/captcha-logs"], requireSuperAdmin, AdminController.getCaptchas);
adminRouter.get("/captchas/:filename/image", requireSuperAdmin, AdminController.getCaptchaImage);

// System & Audit Logs (Superadmin)
adminRouter.get("/logs", requireSuperAdmin, AdminController.getLogs);
adminRouter.post("/logs/:id/revert", requireSuperAdmin, AdminController.revertLog);
adminRouter.get("/cache-stats", requireSuperAdmin, AdminController.getCacheStats);

// App Releases & Version Broadcast (Superadmin)
adminRouter.post("/releases/upload", requireSuperAdmin, uploadRelease.single("installer"), AdminController.uploadRelease);
adminRouter.post("/releases/broadcast", requireSuperAdmin, AdminController.broadcastRelease);
adminRouter.get("/releases", requireSuperAdmin, AdminController.getReleases);

