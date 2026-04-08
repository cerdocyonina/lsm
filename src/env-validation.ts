import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z.url().optional(),
  DATABASE_PATH: z.string().min(1).default("./data.sqlite"),
  LEGACY_CONFIG_PATH: z.string().min(1).default("./config.json"),
  SUB_LINK_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnvOrThrow(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(z.prettifyError(error));
    }

    throw error;
  }
}

class Config {
  private env: Env | null = null;

  public init(env: Env): void {
    this.env = env;
  }

  public get<K extends keyof Env>(key: K): Env[K] {
    if (!this.env) {
      throw new Error("config is not initialized");
    }

    return this.env[key];
  }
}

export const config = new Config();
