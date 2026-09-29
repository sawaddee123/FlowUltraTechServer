import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  JWT_TOKEN: z.string().min(1, "JWT_TOKEN is required"),
  JWT_REFRESH_SECRET: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8001),
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017/flowultratech"),
  ROOT_USERNAME: z.string().default("root"),
  ROOT_PASSWORD: z.string().default("root123456"),
  ROOT_EMAIL: z.string().default("root@system.local"),
  TELEGRAM_DEFAULT_BOT_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("FATAL: invalid environment variables");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
