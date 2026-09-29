import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (err, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    console.error("Warning: Headers already sent for API error, cannot send new response:", err);
    next(err);
    return;
  }

  console.error("API Error (from errorHandler):", err);
  res.status(500).json({ message: "An unexpected server error occurred." });
};

export const installProcessHandlers = (): void => {
  process.on("unhandledRejection", (reason, promise) => {
    console.error("CRITICAL: Unhandled Rejection at Promise:", promise, "Reason:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("CRITICAL: Uncaught Exception:", err);
  });
};
