import crypto from "node:crypto";
import fs from "node:fs/promises";

/**
 * Extracts semver version from filename (e.g. TiktokStudioSandbox-1.0.2.exe -> "1.0.2")
 */
export const extractVersionFromFilename = (filename: string): string | null => {
  if (!filename) return null;
  // Match patterns like 1.2.3 or 1.2.3.4 preceded by - or _ or v or space or start of string
  const match = filename.match(/(?:[vV]|setup[_\-\.]?|version[_\-\.]?|[_\-\s])?(\d+\.\d+\.\d+(?:\.\d+)?)/i);
  if (match && match[1]) {
    return match[1];
  }
  return null;
};

/**
 * Parses semver string into numeric tuple [major, minor, patch]
 */
export const parseSemver = (v: string): [number, number, number] => {
  const clean = v.replace(/^v/i, "").trim();
  const parts = clean.split(".").map(p => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
};

/**
 * Compares two semver strings: returns > 0 if v1 > v2, < 0 if v1 < v2, 0 if equal
 */
export const compareSemver = (v1: string, v2: string): number => {
  const [maj1, min1, pat1] = parseSemver(v1);
  const [maj2, min2, pat2] = parseSemver(v2);
  if (maj1 !== maj2) return maj1 - maj2;
  if (min1 !== min2) return min1 - min2;
  return pat1 - pat2;
};

/**
 * Attempts to extract ProductVersion or FileVersion from Windows PE binary buffer (.exe)
 */
export const extractVersionFromPEBuffer = (buffer: Buffer): string | null => {
  try {
    // Windows PE version resources store strings in UTF-16LE
    const patterns = [
      Buffer.from("P\0r\0o\0d\0u\0c\0t\0V\0e\0r\0s\0i\0o\0n\0", "binary"),
      Buffer.from("F\0i\0l\0e\0V\0e\0r\0s\0i\0o\0n\0", "binary"),
    ];

    for (const pattern of patterns) {
      const idx = buffer.indexOf(pattern);
      if (idx !== -1) {
        // Look up to 256 bytes after the key
        const slice = buffer.subarray(idx + pattern.length, idx + pattern.length + 256);
        // Convert to string and find semver
        const decoded = slice.toString("utf16le");
        const match = decoded.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
        if (match && match[1]) {
          return match[1];
        }
      }
    }
  } catch (err) {
    console.warn("[versionDetector] Error parsing PE buffer:", err);
  }
  return null;
};

/**
 * Detects version from uploaded file using filename or PE header
 */
export const detectFileVersion = async (filePath: string, originalFilename: string): Promise<string> => {
  // 1. Try filename extraction first
  const fromName = extractVersionFromFilename(originalFilename);
  if (fromName) return fromName;

  // 2. If .exe file, read part of the file to inspect PE header
  if (originalFilename.toLowerCase().endsWith(".exe")) {
    try {
      const handle = await fs.open(filePath, "r");
      // Read first 2MB or whole file if smaller
      const stats = await handle.stat();
      const readSize = Math.min(stats.size, 5 * 1024 * 1024);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, 0);
      await handle.close();

      const fromPE = extractVersionFromPEBuffer(buffer);
      if (fromPE) return fromPE;
    } catch {
      // ignore
    }
  }

  return "1.0.0";
};

/**
 * Calculates SHA256 checksum of a file
 */
export const calculateFileSha256 = async (filePath: string): Promise<string> => {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
};
