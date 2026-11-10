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
  // Named-placeholder credentials ({user}, {pass}, ...). Absent in legacy dumps.
  credentials: z.record(z.string(), z.string()).optional(),
});

export const fullDumpNodeSchema = z.object({
  hostName: z.string().optional(),
  name: z.string().min(1),
  url: z.string().url(),
  secret: z.string().min(1),
  // nonnegative, not positive: naive/shadowsocks/mieru nodes have no inbound and store 0.
  inboundId: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  type: z.enum(["xui", "naive", "shadowsocks", "mieru"]).optional(),
});

export const fullDumpServerSchema = z.object({
  connectionKey: z.string().optional(),
  displayName: z.string().nullable().optional(),
  name: z.string().min(1),
  sortOrder: z.number().int().nonnegative(),
  template: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  nodeName: z.string().min(1).nullable().optional(),
});

export const fullDumpSchema = z.object({
  USERS: z.array(fullDumpUserSchema),
  SERVERS: z.array(fullDumpServerSchema),
  NODES: z.array(fullDumpNodeSchema).optional(),
});

export type FullDump = z.infer<typeof fullDumpSchema>;
export type FullDumpUser = z.infer<typeof fullDumpUserSchema>;
export type FullDumpServer = z.infer<typeof fullDumpServerSchema>;
export type FullDumpNode = z.infer<typeof fullDumpNodeSchema>;

// ProfileDump is the same shape as FullDump — single-profile snapshot
export const profileDumpSchema = fullDumpSchema;
export type ProfileDump = FullDump;

// Multi-profile dump: { profiles: { "main": ProfileDump, "work": ProfileDump, ... }, nodes: [...] }
export const multiProfileDumpSchema = z.object({
  profiles: z.record(z.string().min(1), profileDumpSchema),
  nodes: z.array(fullDumpNodeSchema).optional(),
  hosts: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.url(),
        secret: z.string().min(1),
        createdAt: z.number(),
      }),
    )
    .optional(),
  connections: z
    .array(
      z.object({
        key: z.string(),
        name: z.string().min(1),
        template: z.string().min(1),
        nodeName: z.string().nullable(),
        createdAt: z.number(),
      }),
    )
    .optional(),
});
export type MultiProfileDump = z.infer<typeof multiProfileDumpSchema>;

export type ParsedDump =
  | { kind: "multi-profile"; data: MultiProfileDump }
  | { kind: "single-profile"; data: ProfileDump }
  | { kind: "legacy"; data: LegacyConfig };

export function parseDumpOrThrow(data: unknown): ParsedDump {
  if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    if (
      "profiles" in obj &&
      obj.profiles !== null &&
      typeof obj.profiles === "object" &&
      !Array.isArray(obj.profiles)
    ) {
      try {
        return {
          kind: "multi-profile",
          data: multiProfileDumpSchema.parse(data),
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(
            `Invalid multi-profile dump format: ${z.prettifyError(error)}`,
          );
        }
        throw error;
      }
    }

    if (Array.isArray(obj.USERS)) {
      try {
        return { kind: "single-profile", data: profileDumpSchema.parse(data) };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(
            `Invalid single-profile dump format: ${z.prettifyError(error)}`,
          );
        }
        throw error;
      }
    }
  }

  try {
    return { kind: "legacy", data: legacyConfigSchema.parse(data) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Unrecognized or invalid import format: ${z.prettifyError(error)}`,
      );
    }
    throw error;
  }
}
