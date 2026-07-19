import { describe, expect, test } from "bun:test";

import { parsePluginOptions } from "./plugin-options.js";

describe("parsePluginOptions", () => {
  test("owns deterministic workflow and lifecycle defaults", () => {
    expect(parsePluginOptions({})).toEqual({
      compactionSnapshotMaxChars: 12_000,
      duplicateReportLimit: 3,
      lockRetryMs: 10,
      lockTimeoutMs: 5000,
      registerAgents: true,
      staleLockMs: 60_000,
      thresholds: {
        checkpointStaleMs: 900_000,
        firstCheckpointMs: 300_000,
        steeringUnacknowledgedMs: 60_000,
      },
      workflowEnforcement: "required",
    });
    expect(parsePluginOptions(undefined)).toEqual(parsePluginOptions({}));
  });

  test("accepts bounded explicit policy", () => {
    expect(
      parsePluginOptions({
        duplicateReportLimit: 1,
        registerAgents: false,
        statePath: "/tmp/orchestrator-state.json",
        workflowEnforcement: "advisory",
      })
    ).toMatchObject({
      duplicateReportLimit: 1,
      registerAgents: false,
      statePath: "/tmp/orchestrator-state.json",
      workflowEnforcement: "advisory",
    });
  });

  test.each([
    { duplicateReportLimit: 0 },
    { duplicateReportLimit: 11 },
    { workflowEnforcement: "sometimes" },
    { statePath: "" },
    { unknownOption: true },
  ])("rejects malformed or unknown public options: %o", (options) => {
    expect(() => parsePluginOptions(options)).toThrow();
  });
});
