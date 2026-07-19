import { z } from "zod";

const isPrintableIdentifier = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

export const ExternalIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    isPrintableIdentifier,
    "Identifier must not contain ASCII control characters."
  );

export const WorkerProfileSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    isPrintableIdentifier,
    "Worker profile must not contain ASCII control characters."
  );

export const WorkerProfileDescriptorSchema = z
  .object({
    description: z.string().trim().min(1).max(1000),
    profile: WorkerProfileSchema,
  })
  .strict();

export const WorkflowEnforcementSchema = z.enum([
  "required",
  "advisory",
  "off",
]);

export const TimestampSchema = z.iso.datetime({ offset: true });

export type ExternalId = z.infer<typeof ExternalIdSchema>;
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;
export type WorkerProfileDescriptor = z.infer<
  typeof WorkerProfileDescriptorSchema
>;
export type WorkflowEnforcement = z.infer<typeof WorkflowEnforcementSchema>;

export const parseExternalId = (input: unknown): ExternalId =>
  ExternalIdSchema.parse(input);
