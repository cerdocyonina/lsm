import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ADMIN_PORT: z.coerce.number().int().min(1).max(65535),
  BASE_URL: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.url().transform((value) => value.replace(/\/+$/, "")),
  ),
  DATABASE_PATH: z.string().min(1).default("./data.sqlite"),
  SUB_LINK_SECRET: z.string().min(16),
  ADMIN_PATH: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.trim().replace(/^\/+|\/+$/g, "")
        : value,
    z
      .string()
      .min(12)
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "ADMIN_PATH must use only letters, numbers, underscores, or hyphens.",
      )
      .transform((value) => `/${value}`),
  ),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  ADMIN_SESSION_SECRET: z.string().min(16),
  FALLBACK_URL: z.url().default("https://en.wikipedia.org/wiki/Main_Page"),
  XUI_HOST: z.url().optional(),
  XUI_USER: z.string().optional(),
  XUI_PASSWORD: z.string().optional(),
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
