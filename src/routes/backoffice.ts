import express, { type Router, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";

export const backofficeRouter: Router = express.Router();

const candidates = [
  path.join(process.cwd(), "backoffice", "dist"),
  path.join(process.cwd(), "..", "backoffice", "dist"),
  path.join(process.cwd(), "dist", "backoffice"),
];

const distPath =
  candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) || candidates[0];

// Serve static assets from Vite React build
backofficeRouter.use(express.static(distPath));

// SPA fallback for /admin, /admin/*, /backoffice, /backoffice/*
backofficeRouter.get("*", (_req: Request, res: Response) => {
  const indexPath = path.join(distPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.sendFile(indexPath);
  } else {
    res
      .status(503)
      .send(
        "<html><body style='background:#09090b;color:#f4f4f5;font-family:sans-serif;padding:40px;text-align:center;'><h2>Backoffice frontend is building...</h2><p>Please run 'npm run build' in backoffice directory.</p></body></html>"
      );
  }
});
