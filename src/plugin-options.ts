import { z } from "zod";

import { WorkflowEnforcementSchema } from "./schema/common.js";

const LifecycleThresholdsSchema = z
  .object({
    checkpointStaleMs: z.int().nonnegative().default(900_000),
    firstCheckpointMs: z.int().nonnegative().default(300_000),
    steeringUnacknowledgedMs: z.int().nonnegative().default(60_000),
  })
  .strict()
  .prefault({});

export const PluginOptionsSchema = z
  .object({
    compactionSnapshotMaxChars: z.int().min(1024).max(100_000).default(12_000),
    duplicateReportLimit: z.int().min(1).max(10).default(3),
    lockRetryMs: z.int().nonnegative().default(10),
    lockTimeoutMs: z.int().nonnegative().default(5000),
    registerAgents: z.boolean().default(true),
    staleLockMs: z.int().nonnegative().default(60_000),
    statePath: z.string().min(1).optional(),
    thresholds: LifecycleThresholdsSchema,
    workflowEnforcement: WorkflowEnforcementSchema.default("required"),
  })
  .strict();

export type PluginOptions = z.infer<typeof PluginOptionsSchema>;

export const parsePluginOptions = (input: unknown): PluginOptions =>
  PluginOptionsSchema.parse(input === undefined ? {} : input);
