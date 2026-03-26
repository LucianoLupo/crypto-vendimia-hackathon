import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  KAPSO_API_KEY: z.string().min(1, "KAPSO_API_KEY is required"),
  KAPSO_WEBHOOK_SECRET: z.string().min(1, "KAPSO_WEBHOOK_SECRET is required"),
  KAPSO_PHONE_NUMBER_ID: z.string().min(1, "KAPSO_PHONE_NUMBER_ID is required"),
  MASTER_MNEMONIC: z.string().min(1, "MASTER_MNEMONIC is required"),
  RSK_RPC_URL: z.string().url("RSK_RPC_URL must be a valid URL"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  WALLET_ENCRYPTION_KEY: z.string().optional(),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment configuration:");
  result.error.errors.forEach((err) => {
    console.error(`  ${err.path.join(".")}: ${err.message}`);
  });
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
