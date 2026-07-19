import { describe, expect, test } from "bun:test";

import {
  ExternalIdSchema,
  parseExternalId,
  WorkerProfileSchema,
} from "./common.js";

describe("ExternalIdSchema", () => {
  test("accepts stable printable identifiers", () => {
    expect(parseExternalId("parent-1")).toBe("parent-1");
    expect(ExternalIdSchema.parse("cp_v1_000000000001")).toBe(
      "cp_v1_000000000001"
    );
  });

  test.each([
    "",
    "parent\u0000child",
    "line\nbreak",
    "tab\tvalue",
  ])("rejects empty or control-character identifier %j", (value) => {
    expect(ExternalIdSchema.safeParse(value).success).toBe(false);
  });

  test("rejects identifiers above the durable boundary", () => {
    expect(ExternalIdSchema.safeParse("x".repeat(513)).success).toBe(false);
  });
});

describe("WorkerProfileSchema", () => {
  test("accepts configured semantic profile names without a bundled enum", () => {
    expect(WorkerProfileSchema.parse("terra-max")).toBe("terra-max");
    expect(WorkerProfileSchema.parse("my-local-reviewer")).toBe(
      "my-local-reviewer"
    );
    expect(WorkerProfileSchema.parse("  build  ")).toBe("build");
  });

  test.each([
    "",
    "line\nbreak",
    "x".repeat(513),
  ])("rejects invalid configured profile name %j", (profile) => {
    expect(WorkerProfileSchema.safeParse(profile).success).toBe(false);
  });
});
