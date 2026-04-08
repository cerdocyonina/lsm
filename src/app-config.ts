import { readFileSync } from "node:fs";
import { z } from "zod";

const appConfigSchema = z.object({
  USERS: z.record(z.string(), z.uuid()),
  SERVERS: z.array(z.string().min(1)).min(1),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadAppConfigOrThrow(path: string): AppConfig {
  let fileContent: string;

  try {
    fileContent = readFileSync(path, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown file read error";
    throw new Error(`Failed to read app config at ${path}: ${message}`);
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(fileContent);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown JSON parse error";
    throw new Error(`Failed to parse app config at ${path}: ${message}`);
  }

  try {
    return appConfigSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(z.prettifyError(error));
    }

    throw error;
  }
}
