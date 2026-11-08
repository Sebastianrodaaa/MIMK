import { z } from "zod";

export const SubjectSchema = z.object({
  id: z.string(),
  type: z.enum(["volunteer", "public_figure"]),
  name: z.string().min(1),
  approvedSources: z.array(z.string().min(1)).min(1),
  consent: z.literal(true),
  consentedAt: z.string(),
  handles: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Subject = z.infer<typeof SubjectSchema>;

export const CreateSubjectSchema = SubjectSchema.omit({ id: true, createdAt: true, consentedAt: true });
export type CreateSubject = z.infer<typeof CreateSubjectSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  status: z.enum(["queued", "running", "done", "failed"]),
  containerId: z.string().optional(),
  vncPort: z.number().optional(),
  backend: z.enum(["docker", "h"]).default("docker"),
  hSessionId: z.string().optional(),
  liveViewUrl: z.string().optional(),
  agentViewUrl: z.string().optional(),
  task: z.string().optional(),
  createdAt: z.string(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentEventSchema = z.object({
  runId: z.string(),
  ts: z.string(),
  kind: z.enum(["log", "action", "finding", "screenshot"]),
  data: z.unknown(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const FindingSchema = z.object({
  runId: z.string(),
  sourceUrl: z.string(),
  summary: z.string(),
  ts: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

const PHONE = /(\+\d[\d\s().-]{7,}\d|\d[\d\s().-]{9,}\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STREET =
  /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}\s(street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?|place|pl\.?|parkway|pkwy\.?|terrace|ter\.?)\b/gi;

export function filterSensitive(text: string): string {
  return text
    .replace(EMAIL, "[redacted-email]")
    // >=10 digits, or + followed by >=8 digits; year ranges/dates have too few digits
    .replace(PHONE, (m) => {
      const digits = (m.match(/\d/g) ?? []).length;
      return digits >= 10 || (m.trimStart().startsWith("+") && digits >= 8) ? "[redacted-phone]" : m;
    })
    .replace(STREET, "[redacted-address]");
}

export const DossierFactSchema = z.object({
  claim: z.string(),
  sourceUrl: z.string(),
  confidence: z.number().min(0).max(1),
});
export type DossierFact = z.infer<typeof DossierFactSchema>;

export const DossierSchema = z.object({
  subjectId: z.string(),
  facts: z.array(DossierFactSchema),
  summary: z.string(),
});
export type Dossier = z.infer<typeof DossierSchema>;

export const PersonaSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  name: z.string(),
  traits: z.array(z.string()),
  stances: z.array(z.string()),
  speechStyle: z.string(),
  interests: z.array(z.string()),
  relationships: z.array(z.string()),
  avatar: z.object({
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2),
    accessory: z.enum(["none", "hat", "glasses", "scarf", "headphones"]),
  }),
  bio: z.string(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const SimEventSchema = z.object({
  personaId: z.string(),
  ts: z.string(),
  kind: z.enum(["post", "reply", "like", "follow"]),
  text: z.string(),
  targetId: z.string().optional(),
});
export type SimEvent = z.infer<typeof SimEventSchema>;
