import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import cors from "cors";
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/error.js";
import { showRequestLog, showResponseErrorLog } from "./middlewares/request.js";
import { captchaRouter } from "./routes/captcha.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { slotsRouter } from "./routes/slots.js";
import { backofficeRouter } from "./routes/backoffice.js";
import { securityRouter } from "./routes/security.js";
import { profilesRouter } from "./routes/profiles.js";
import { proxiesRouter } from "./routes/proxies.js";
import { AdminController } from "./controllers/adminController.js";

export const buildApp = (): Express => {
  const app = express();

  app.set("trust proxy", env.TRUST_PROXY);

  app.use(showRequestLog);
  app.use(showResponseErrorLog);
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  const publicDir = path.join(process.cwd(), "public");
  app.use("/public", express.static(publicDir));

  // Root endpoint: Serves public landing page for browsers, or JSON for API calls
  app.get("/", (req, res) => {
    if (req.accepts("html") && !req.xhr && !req.path.startsWith("/api")) {
      const indexPath = path.join(publicDir, "index.html");
      if (existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
    }
    res.json({ service: "captcha-service", status: "ok", version: "2.0.0" });
  });

  // Dedicated Landing & Download Page Route
  app.get(["/download", "/landing"], (_req, res) => {
    const indexPath = path.join(publicDir, "index.html");
    if (existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    res.redirect("/");
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  // Mount Storage directory for captcha image previews and release installers
  app.use("/storage", express.static(path.join(process.cwd(), "storage")));

  // Mount Backoffice Web UI
  app.use("/backoffice", backofficeRouter);
  app.use("/admin", backofficeRouter);

  // Mount Public App Release Info & Direct Installer Download
  app.get(["/api/v1/app/latest-release", "/app/latest-release"], AdminController.getLatestRelease);
  app.get(
    ["/api/v1/app/releases", "/app/releases", "/api/v1/app/versions"],
    AdminController.getPublicReleases
  );
  app.get(
    ["/api/v1/app/download", "/download/installer", "/download/setup"],
    AdminController.downloadInstaller
  );

  // Mount API v1 Routes
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1/slots", slotsRouter);
  app.use("/api/v1/security", securityRouter);
  app.use("/api/v1/profiles", profilesRouter);
  app.use("/api/v1/proxies", proxiesRouter);

  // Mount aliases for backward compatibility (/login, /me, /refreshToken, /logout)
  app.use(authRouter);

  // Captcha Routes (/captcha/slide, /captcha/symbol, /api/v1/captcha/slide, /api/v1/captcha/symbol)
  app.use(captchaRouter);
  app.use("/api/v1", captchaRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);

  return app;
};
