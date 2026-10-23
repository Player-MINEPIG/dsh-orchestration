import { z } from "zod";

/** Remote device controls are limited to its own origin tasks. */
export const CentralTaskControl = z.object({
  action: z.enum(["cancel", "status"]),
  taskId: z.string().min(1).max(200),
  expectedVersion: z.string().min(1).max(200),
  runId: z.string().min(1).max(200).nullable(),
  confirmationRevision: z.number().int().positive().default(1),
}).strict();
export type CentralTaskControl = z.infer<typeof CentralTaskControl>;
