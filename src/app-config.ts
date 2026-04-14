import { readFileSync } from "node:fs";
import { z } from "zod";

// Legacy "plain" format: { USERS: { name: uuid }, SERVERS: [template, ...] }
export const legacyConfigSchema = z.object({
  USERS: z.record(z.string(), z.uuid()),
  SERVERS: z.array(z.string().min(1)).min(1),
});

export type LegacyConfig = z.infer<typeof legacyConfigSchema>;

// Full dump format: complete database snapshot preserving all fields
export const fullDumpUserSchema = z.object({
  clientName: z.string().min(1),
  userUuid: z.uuid(),
  subscriptionToken: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});

export const fullDumpServerSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().nonnegative(),
  template: z.string().min(1),
});

export const fullDumpSchema = z.object({
  USERS: z.array(fullDumpUserSchema),
  SERVERS: z.array(fullDumpServerSchema).min(1),
});

export type FullDump = z.infer<typeof fullDumpSchema>;
export type FullDumpUser = z.infer<typeof fullDumpUserSchema>;
export type FullDumpServer = z.infer<typeof fullDumpServerSchema>;

function readAndParseJsonFile(path: string): unknown {
  let fileContent: string;

  try {
    fileContent = readFileSync(path, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown file read error";
    throw new Error(`Failed to read file at ${path}: ${message}`);
  }

  try {
    return JSON.parse(fileContent);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown JSON parse error";
    throw new Error(`Failed to parse JSON at ${path}: ${message}`);
  }
}

export function loadDumpOrThrow(path: string): FullDump | LegacyConfig {
  const parsedJson = readAndParseJsonFile(path);

  // Detect format: full dump has USERS as an array, legacy has it as an object
  if (
    parsedJson !== null &&
    typeof parsedJson === "object" &&
    Array.isArray((parsedJson as Record<string, unknown>).USERS)
  ) {
    try {
      return fullDumpSchema.parse(parsedJson);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid full dump format at ${path}: ${z.prettifyError(error)}`);
      }
      throw error;
    }
  }

  try {
    return legacyConfigSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid config format at ${path}: ${z.prettifyError(error)}`);
    }
    throw error;
  }
}

/** @deprecated Use loadDumpOrThrow instead */
export function loadLegacyAppConfigOrThrow(path: string): LegacyConfig {
  const parsedJson = readAndParseJsonFile(path);

  try {
    return legacyConfigSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(z.prettifyError(error));
    }

    throw error;
  }
}
