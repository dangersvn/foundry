import { z } from "zod";

// The one boundary where agent output enters the kernel. The runtime turns
// ACP traffic into these events and validates each before the kernel
// records it. Nothing an agent says can change item status; only the
// verifier can.
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent_started"),
    agent: z.string(),
    agentInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).loose().nullish(),
    capabilities: z.record(z.string(), z.unknown()).nullish(),
    transcript: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string(),
    kind: z.string(),
    status: z.enum(["completed", "failed"]),
    paths: z.array(z.string()),
  }),
  z.object({
    type: z.literal("permission"),
    toolCallId: z.string(),
    title: z.string(),
    kind: z.string(),
    allow: z.boolean(),
    reason: z.string(),
    paths: z.array(z.string()),
    command: z.string().optional(),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal("agent_finished"),
    stopReason: z.string(),
    message: z.string(),
    usage: z.unknown().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
