import { describe, expect, test } from "bun:test";
import { createNodeSchema, updateNodeSchema } from "./admin-api";

const base = { name: "n1", url: "http://n1:9000", secret: "s" };

describe("createNodeSchema", () => {
  test("по умолчанию xui — старые клиенты панели не ломаются", () => {
    expect(createNodeSchema.parse({ ...base, inboundId: 1 }).type).toBe("xui");
  });

  test("xui требует inboundId >= 1", () => {
    expect(createNodeSchema.safeParse({ ...base, type: "xui" }).success).toBe(false);
    expect(createNodeSchema.safeParse({ ...base, type: "xui", inboundId: 0 }).success).toBe(false);
  });

  test("naive не требует inboundId и получает 0", () => {
    const parsed = createNodeSchema.parse({ ...base, type: "naive" });
    expect(parsed.type).toBe("naive");
    expect(parsed.inboundId).toBe(0);
  });

  test("naive допускает явный inboundId=0", () => {
    expect(createNodeSchema.safeParse({ ...base, type: "naive", inboundId: 0 }).success).toBe(true);
  });

  test("неизвестный тип отвергается", () => {
    expect(createNodeSchema.safeParse({ ...base, type: "wireguard", inboundId: 1 }).success).toBe(false);
  });
});

describe("updateNodeSchema", () => {
  test("можно поменять только тип", () => {
    expect(updateNodeSchema.parse({ type: "naive" }).type).toBe("naive");
  });

  test("пустой апдейт отвергается", () => {
    expect(updateNodeSchema.safeParse({}).success).toBe(false);
  });

  test("inboundId=0 допустим", () => {
    expect(updateNodeSchema.safeParse({ inboundId: 0 }).success).toBe(true);
  });
});
