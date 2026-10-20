import crypto from "node:crypto";
import sharp from "sharp";

/**
 * Global (server-wide) captcha answer cache.
 * - Only answers CONFIRMED by TikTok (VERIFIED_SUCCESS feedback) are stored, so reuse is safe.
 * - Exact SHA-256 match is the fast path; otherwise a perceptual match: 256-bit dHash
 *   Hamming distance <= MAX_HAMMING (~97% similar) AND a 64x64 grayscale mean-diff check.
 * - An entry that later gets VERIFIED_FAILED is evicted. LRU cap bounds memory.
 */
const MAX_ENTRIES = Number(process.env.CAPTCHA_CACHE_MAX || 5000);
const MAX_HAMMING = Number(process.env.CAPTCHA_CACHE_HAMMING || 6); // of 256 bits
const MAX_MEAN_DIFF = 3; // 0-255 gray levels
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENABLED = process.env.CAPTCHA_CACHE !== "off";

type Kind = "slide" | "symbol";
interface Entry {
  kind: Kind;
  sha: string;
  dhash: Uint8Array;
  gray: Uint8Array;
  width: number;
  height: number;
  answer: Record<string, unknown>;
  at: number;
  hits: number;
}

const entries = new Map<string, Entry>(); // key: kind:sha, insertion order = LRU order
const pendingByCaptcha = new Map<string, { key: string; at: number }>(); // reused captchaId -> entry key
const stats = { exact: 0, near: 0, miss: 0, evicted: 0 };

export interface Fingerprint {
  sha: string;
  dhash: Uint8Array;
  gray: Uint8Array;
  width: number;
  height: number;
}

export const fingerprint = async (buf: Buffer): Promise<Fingerprint | null> => {
  try {
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const meta = await sharp(buf).metadata();
    const small = await sharp(buf).greyscale().resize(17, 16, { fit: "fill" }).raw().toBuffer();
    const dhash = new Uint8Array(32);
    let bit = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (small[y * 17 + x] > small[y * 17 + x + 1]) dhash[bit >> 3] |= 1 << (bit & 7);
        bit++;
      }
    }
    const gray = new Uint8Array(await sharp(buf).greyscale().resize(64, 64, { fit: "fill" }).raw().toBuffer());
    return { sha, dhash, gray, width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch {
    return null;
  }
};

const popcount = (n: number): number => {
  n -= (n >> 1) & 0x55;
  n = (n & 0x33) + ((n >> 2) & 0x33);
  return (n + (n >> 4)) & 0x0f;
};

const hamming = (a: Uint8Array, b: Uint8Array): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += popcount(a[i] ^ b[i]);
  return d;
};

const meanDiff = (a: Uint8Array, b: Uint8Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

export const lookup = (kind: Kind, fp: Fingerprint): { key: string; answer: Record<string, unknown>; match: "exact" | "near" } | null => {
  if (!ENABLED) return null;
  const now = Date.now();
  const exactKey = `${kind}:${fp.sha}`;
  const hit = entries.get(exactKey);
  if (hit && now - hit.at < TTL_MS) {
    hit.hits++;
    entries.delete(exactKey);
    entries.set(exactKey, hit);
    stats.exact++;
    return { key: exactKey, answer: hit.answer, match: "exact" };
  }
  let best: { key: string; e: Entry; d: number } | null = null;
  for (const [key, e] of entries) {
    if (e.kind !== kind || e.width !== fp.width || e.height !== fp.height) continue;
    if (now - e.at >= TTL_MS) continue;
    const d = hamming(e.dhash, fp.dhash);
    if (d <= MAX_HAMMING && (!best || d < best.d) && meanDiff(e.gray, fp.gray) <= MAX_MEAN_DIFF) {
      best = { key, e, d };
    }
  }
  if (best) {
    best.e.hits++;
    stats.near++;
    return { key: best.key, answer: best.e.answer, match: "near" };
  }
  stats.miss++;
  return null;
};

export const store = (kind: Kind, fp: Fingerprint, answer: Record<string, unknown>): void => {
  if (!ENABLED) return;
  const key = `${kind}:${fp.sha}`;
  entries.delete(key);
  entries.set(key, { kind, ...fp, answer, at: Date.now(), hits: 0 });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
};

const pendingSolved = new Map<string, { kind: Kind; fp: Fingerprint; answer: Record<string, unknown>; at: number }>();

/** Remember a fresh solve until TikTok feedback confirms it. */
export const rememberSolve = (captchaId: string, kind: Kind, fp: Fingerprint, answer: Record<string, unknown>): void => {
  if (!ENABLED) return;
  pendingSolved.set(captchaId, { kind, fp, answer, at: Date.now() });
  if (pendingSolved.size > 2000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, v] of pendingSolved) if (v.at < cutoff) pendingSolved.delete(id);
    while (pendingSolved.size > 2000) pendingSolved.delete(pendingSolved.keys().next().value as string);
  }
};

/** TikTok accepted this solve: promote it into the shared cache. */
export const confirmSolve = (captchaId: string): void => {
  const p = pendingSolved.get(captchaId);
  pendingSolved.delete(captchaId);
  if (p) store(p.kind, p.fp, p.answer);
};

export const markReused = (captchaId: string, key: string): void => {
  pendingByCaptcha.set(captchaId, { key, at: Date.now() });
  if (pendingByCaptcha.size > 5000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, v] of pendingByCaptcha) if (v.at < cutoff) pendingByCaptcha.delete(id);
  }
};

/** Called on TikTok failure feedback: drop the cached answer that produced the failed solve. */
export const evictForCaptcha = (captchaId: string): boolean => {
  pendingSolved.delete(captchaId);
  const p = pendingByCaptcha.get(captchaId);
  pendingByCaptcha.delete(captchaId);
  if (p && entries.delete(p.key)) {
    stats.evicted++;
    return true;
  }
  return false;
};

export const cacheStats = () => ({ ...stats, size: entries.size, enabled: ENABLED });
