import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const PYTHON_SERVICE_PORT = process.env.SYMBOL_SERVICE_PORT || "3008";
const PYTHON_SERVICE_URL = `http://127.0.0.1:${PYTHON_SERVICE_PORT}`;

let pythonDaemonProcess: ChildProcess | null = null;
let isStartingDaemon = false;

/**
 * Checks if the Python Symbol Service is healthy and responsive
 */
export const checkSymbolServiceHealth = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch(`${PYTHON_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
};

/**
 * Spawns and manages the Python Symbol Service Daemon in the background
 */
export const ensurePythonSymbolDaemon = async (): Promise<boolean> => {
  const isHealthy = await checkSymbolServiceHealth();
  if (isHealthy) return true;

  if (isStartingDaemon) {
    // Wait for in-progress startup
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkSymbolServiceHealth()) return true;
    }
  }

  isStartingDaemon = true;
  try {
    const pythonScript = path.join(process.cwd(), "python", "symbol_service.py");
    console.log(`[symbol] 🚀 Launching Python Symbol Solver Daemon on port ${PYTHON_SERVICE_PORT}...`);

    pythonDaemonProcess = spawn("python", [pythonScript, "--port", PYTHON_SERVICE_PORT], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    pythonDaemonProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[python-symbol] ${msg}`);
    });

    pythonDaemonProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.warn(`[python-symbol] ${msg}`);
    });

    pythonDaemonProcess.on("exit", (code, signal) => {
      console.log(`[symbol] Python daemon exited (code: ${code}, signal: ${signal})`);
      pythonDaemonProcess = null;
    });

    // Wait for health endpoint to respond (up to 15 seconds for model preload)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkSymbolServiceHealth()) {
        console.log(`[symbol] ✅ Python Symbol Daemon is online and healthy!`);
        isStartingDaemon = false;
        return true;
      }
    }

    console.warn("[symbol] ⚠️ Python daemon health check timed out after 15s");
    isStartingDaemon = false;
    return false;
  } catch (err) {
    console.error("[symbol] Failed to spawn Python symbol daemon:", err);
    isStartingDaemon = false;
    return false;
  }
};

/**
 * Gracefully shuts down the Python Symbol Daemon
 */
export const stopPythonSymbolDaemon = (): void => {
  if (pythonDaemonProcess) {
    try {
      console.log("[symbol] Stopping Python Symbol Daemon...");
      pythonDaemonProcess.kill("SIGTERM");
      pythonDaemonProcess = null;
    } catch {}
  }
};

/**
 * Fallback solver running Python CLI directly for a single image
 */
const solveWithCliFallback = async (imageBuffer: Buffer): Promise<[[number, number], [number, number]]> => {
  const tempFile = path.join(os.tmpdir(), `symbol_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.png`);
  try {
    await fs.writeFile(tempFile, imageBuffer);
    const pythonScript = path.join(process.cwd(), "python", "symbol_service.py");

    return await new Promise<[[number, number], [number, number]]>((resolve) => {
      const proc = spawn("python", [pythonScript, "--solve", tempFile], { cwd: process.cwd() });
      let output = "";
      proc.stdout.on("data", (d: Buffer) => {
        output += d.toString();
      });

      proc.on("close", (code) => {
        try {
          const lines = output.trim().split("\n");
          const jsonLine = lines.find((l) => l.trim().startsWith("{") && l.trim().endsWith("}"));
          if (jsonLine) {
            const data = JSON.parse(jsonLine);
            if (data.success && Array.isArray(data.symbol_positions) && data.symbol_positions.length >= 2) {
              resolve(data.symbol_positions as [[number, number], [number, number]]);
              return;
            }
          }
        } catch {}
        resolve([[0, 0], [0, 0]]);
      });

      proc.on("error", () => resolve([[0, 0], [0, 0]]));
    });
  } finally {
    try {
      await fs.unlink(tempFile);
    } catch {}
  }
};

/**
 * Finds the pair of matching 3D symbols using FastSAM (.pt) and DINOv2
 */
export const findSameSymbolPosition = async (
  imageInput: string | Buffer
): Promise<[[number, number], [number, number]]> => {
  try {
    let base64Image = "";
    let buffer: Buffer | null = null;

    if (Buffer.isBuffer(imageInput)) {
      buffer = imageInput;
      base64Image = imageInput.toString("base64");
    } else if (typeof imageInput === "string") {
      if (imageInput.startsWith("data:") || imageInput.length > 500) {
        base64Image = imageInput;
      } else {
        // File path
        buffer = await fs.readFile(imageInput);
        base64Image = buffer.toString("base64");
      }
    }

    if (!base64Image) {
      console.warn("[symbol] Empty image provided for symbol detection");
      return [[0, 0], [0, 0]];
    }

    // Ensure daemon is active
    const daemonReady = await ensurePythonSymbolDaemon();
    if (daemonReady) {
      try {
        const resp = await fetch(`${PYTHON_SERVICE_URL}/solve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64Image }),
        });

        if (resp.ok) {
          const result = (await resp.json()) as {
            success: boolean;
            symbol_positions: [[number, number], [number, number]];
            similarity: number;
            time: number;
          };

          if (result.success && Array.isArray(result.symbol_positions) && result.symbol_positions.length >= 2) {
            console.log(
              `[symbol] ✅ Pair found at [${result.symbol_positions[0]}], [${result.symbol_positions[1]}] (Score: ${result.similarity?.toFixed(3)}, Time: ${result.time?.toFixed(3)}s)`
            );
            return result.symbol_positions;
          }
        }
      } catch (reqErr) {
        console.warn("[symbol] Daemon request failed, falling back to CLI runner:", (reqErr as Error).message);
      }
    }

    // Fallback if daemon failed
    if (buffer) {
      return await solveWithCliFallback(buffer);
    } else {
      const cleanB64 = base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
      const buf = Buffer.from(cleanB64, "base64");
      return await solveWithCliFallback(buf);
    }
  } catch (error) {
    console.error("[symbol] Error in findSameSymbolPosition:", error);
    return [[0, 0], [0, 0]];
  }
};
