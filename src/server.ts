import http from "node:http";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { ensureRootUser, ensureTestUser } from "./services/bootstrap.js";
import { installProcessHandlers } from "./middlewares/error.js";
import { buildApp } from "./app.js";
import { ensureImageDirs } from "./routes/captcha.js";
import { initSocketHub } from "./services/socketHub.js";
import { stopPythonSymbolDaemon } from "./ml/symbol.js";

const main = async (): Promise<void> => {
  installProcessHandlers();

  // 1. Connect to MongoDB
  try {
    await connectDb();
  } catch (dbError) {
    console.error("[server] Failed to connect to MongoDB, exiting:", dbError);
    process.exit(1);
  }

  // 2. Bootstrap root & test users
  try {
    await ensureRootUser();
    await ensureTestUser();
  } catch (bootstrapError) {
    console.error("[server] Error during bootstrap:", bootstrapError);
  }

  // 3. Ensure image working directories
  await ensureImageDirs();

  // 4. Build Express app and attach to HTTP server with Socket.IO hub
  const app = buildApp();
  const httpServer = http.createServer(app);
  initSocketHub(httpServer);

  httpServer.listen(env.PORT, () => {
    console.log(`Captcha & Auth Service is running on http://localhost:${env.PORT}`);
    console.log(`MongoDB URI: ${env.MONGODB_URI}`);
    console.log(`Root user: ${env.ROOT_USERNAME}`);

    // Notify PM2 process manager that server is ready to accept traffic
    if (typeof process.send === "function") {
      process.send("ready");
    }
  });

  // Graceful shutdown handling (prevents abrupt connection termination during redeploy)
  const gracefulShutdown = (signal: string) => {
    console.log(`[server] Received ${signal}. Starting graceful shutdown...`);
    try {
      stopPythonSymbolDaemon();
    } catch (e) {
      console.warn("[server] Error stopping python symbol daemon:", e);
    }
    httpServer.close(() => {
      console.log("[server] All ongoing HTTP connections closed gracefully.");
      process.exit(0);
    });

    // Force close after 10s timeout if clients do not close
    setTimeout(() => {
      console.warn("[server] Graceful shutdown timed out (10s). Force exiting.");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
};

void main();

