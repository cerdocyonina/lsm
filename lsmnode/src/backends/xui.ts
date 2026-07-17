import type { XUIService } from "../../../src/3x-ui";
import type { HealthStatus, NodeBackend, OnConflict, SyncResult } from "./types";

/** Тонкая обёртка над XUIService — поведение 3x-ui-пути не меняется. */
export class XuiBackend implements NodeBackend {
  public readonly kind = "xui" as const;

  public constructor(private readonly xui: XUIService) {}

  public health(timeoutMs = 3000): Promise<HealthStatus> {
    return this.xui.ping(timeoutMs);
  }

  public syncUser(
    inboundId: number,
    email: string,
    uuid: string,
    onConflict: OnConflict,
  ): Promise<SyncResult> {
    return this.xui.syncUser(inboundId, email, uuid, onConflict);
  }

  public checkConflicts(emails: string[]): Promise<string[]> {
    return this.xui.checkConflicts(emails);
  }

  public deleteUser(email: string): Promise<SyncResult> {
    return this.xui.deleteUser(email);
  }
}
