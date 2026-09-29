import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type DecodeResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; status: number; message: string };

export const decodeBase64Image = (input: unknown): DecodeResult => {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, status: 400, message: "Missing image in body" };
  }

  // Remove whitespace/newlines and optional Data URL prefix
  const trimmed = input.trim();
  const cleaned = trimmed.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    return { ok: false, status: 400, message: "Invalid image data: not valid base64" };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(cleaned, "base64");
  } catch {
    return { ok: false, status: 400, message: "Invalid image data" };
  }

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, message: "Image too large or empty" };
  }

  return { ok: true, buffer };
};

export const resolveImageInput = async (input: unknown): Promise<DecodeResult> => {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, status: 400, message: "Missing image in body" };
  }

  const str = input.trim();
  if (str.startsWith("http://") || str.startsWith("https://")) {
    try {
      const resp = await fetch(str);
      if (!resp.ok) {
        return { ok: false, status: 400, message: `Failed to fetch image from URL: ${resp.status} ${resp.statusText}` };
      }
      const arrayBuf = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
        return { ok: false, status: 413, message: "Image too large or empty" };
      }
      return { ok: true, buffer };
    } catch (err) {
      return { ok: false, status: 400, message: `Error downloading image: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return decodeBase64Image(input);
};

export const writeTempImage = async (
  buffer: Buffer,
  rootDir: string,
  kind: string,
): Promise<string> => {
  const filename = `${Date.now()}_${crypto.randomUUID()}.png`;
  const outputPath = path.join(rootDir, "images", kind, filename);
  await fs.writeFile(outputPath, buffer);
  return outputPath;
};

export const safeUnlink = (filePath: string): Promise<void> =>
  fs.unlink(filePath).catch(() => undefined);
