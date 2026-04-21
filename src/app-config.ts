import { readFileSync } from "node:fs";
import { z } from "zod";

// Legacy "plain" format: { USERS: { name: uuid }, SERVERS: [template, ...] }
export const legacyConfigSchema = z.object({
  USERS: z.record(z.string(), z.uuid()),
  SERVERS: z.array(z.string().min(1)),
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
  createdAt: z.number().int().nonnegative(),
});

export const fullDumpSchema = z.object({
  USERS: z.array(fullDumpUserSchema),
  SERVERS: z.array(fullDumpServerSchema),
});

export type FullDump = z.infer<typeof fullDumpSchema>;
export type FullDumpUser = z.infer<typeof fullDumpUserSchema>;
export type FullDumpServer = z.infer<typeof fullDumpServerSchema>;

// ProfileDump is the same shape as FullDump — single-profile snapshot
export const profileDumpSchema = fullDumpSchema;
export type ProfileDump = FullDump;

// Multi-profile dump: { profiles: { "main": ProfileDump, "work": ProfileDump, ... } }
export const multiProfileDumpSchema = z.object({
  profiles: z.record(z.string().min(1), profileDumpSchema),
});
export type MultiProfileDump = z.infer<typeof multiProfileDumpSchema>;

export type ParsedDump =
  | { kind: "multi-profile"; data: MultiProfileDump }
  | { kind: "single-profile"; data: ProfileDump }
  | { kind: "legacy"; data: LegacyConfig };

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

export function loadDumpOrThrow(path: string): ParsedDump {
  const parsedJson = readAndParseJsonFile(path);

  if (parsedJson !== null && typeof parsedJson === "object") {
    const obj = parsedJson as Record<string, unknown>;

    // Multi-profile dump: has "profiles" key that is an object (not array)
    if ("profiles" in obj && obj.profiles !== null && typeof obj.profiles === "object" && !Array.isArray(obj.profiles)) {
      try {
        return { kind: "multi-profile", data: multiProfileDumpSchema.parse(parsedJson) };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Invalid multi-profile dump format at ${path}: ${z.prettifyError(error)}`);
        }
        throw error;
      }
    }

    // Single-profile full dump: USERS is an array
    if (Array.isArray(obj.USERS)) {
      try {
        return { kind: "single-profile", data: profileDumpSchema.parse(parsedJson) };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Invalid full dump format at ${path}: ${z.prettifyError(error)}`);
        }
        throw error;
      }
    }
  }

  // Legacy plain format
  try {
    return { kind: "legacy", data: legacyConfigSchema.parse(parsedJson) };
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
