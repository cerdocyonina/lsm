import { describe, expect, test } from "bun:test";
import { fullDumpNodeSchema, fullDumpUserSchema, profileDumpSchema } from "./app-config";

const node = { name: "n1", url: "http://n1:9000", secret: "s", createdAt: 1 };

describe("fullDumpNodeSchema", () => {
  test("naive-нода с inboundId=0 валидна — иначе экспорт naive не импортируется обратно", () => {
    expect(fullDumpNodeSchema.safeParse({ ...node, inboundId: 0, type: "naive" }).success).toBe(true);
  });

  test("отрицательный inboundId отвергается", () => {
    expect(fullDumpNodeSchema.safeParse({ ...node, inboundId: -1 }).success).toBe(false);
  });

  test("легаси-нода без type валидна", () => {
    expect(fullDumpNodeSchema.safeParse({ ...node, inboundId: 1 }).success).toBe(true);
  });

  test("неизвестный type отвергается", () => {
    expect(fullDumpNodeSchema.safeParse({ ...node, inboundId: 0, type: "wireguard" }).success).toBe(false);
  });
});

describe("fullDumpUserSchema", () => {
  const user = {
    clientName: "alice",
    userUuid: "550e8400-e29b-41d4-a716-446655440000",
    subscriptionToken: "tok",
    createdAt: 1,
  };

  test("credentials проходят через схему", () => {
    const parsed = fullDumpUserSchema.parse({ ...user, credentials: { user: "alice", pass: "p1" } });
    expect(parsed.credentials).toEqual({ user: "alice", pass: "p1" });
  });

  test("легаси-юзер без credentials валиден", () => {
    expect(fullDumpUserSchema.safeParse(user).success).toBe(true);
  });

  test("нестроковое значение в credentials отвергается", () => {
    expect(fullDumpUserSchema.safeParse({ ...user, credentials: { pass: 42 } }).success).toBe(false);
  });
});

describe("profileDumpSchema", () => {
  test("дамп с naive-нодой (inboundId=0) проходит целиком", () => {
    const result = profileDumpSchema.safeParse({
      USERS: [
        {
          clientName: "alice",
          userUuid: "550e8400-e29b-41d4-a716-446655440000",
          subscriptionToken: "tok",
          createdAt: 1,
          credentials: { user: "alice", pass: "p1" },
        },
      ],
      SERVERS: [
        { name: "s1", sortOrder: 0, template: "naive+https://{user}:{pass}@h:443#n", createdAt: 1, nodeName: "naive-1" },
      ],
      NODES: [{ ...node, name: "naive-1", inboundId: 0, type: "naive" }],
    });
    expect(result.success).toBe(true);
  });
});
