import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Subject } from "@mimk/shared";

export interface HConfig {
  baseUrl: string;
  apiKey: string;
  agent: string;
  maxSteps: number;
  maxTimeS: number;
}

export class HError extends Error {
  constructor(public status: number, body: string) {
    const nice =
      status === 401 ? "unauthorized — check HAI_API_KEY" :
      status === 429 ? "rate limited / no free slots" :
      status === 422 ? `unprocessable: ${body.slice(0, 200)}` :
      `HTTP ${status}: ${body.slice(0, 200)}`;
    super(nice);
  }
}

async function req(
  fetchFn: typeof fetch, cfg: HConfig, method: string, path: string, body?: unknown
) {
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new HError(res.status, text);
  return text ? JSON.parse(text) : null;
}

export function createClient(cfg: HConfig, fetchFn: typeof fetch = fetch) {
  return {
    createSession(subject: Subject, task: string) {
      return req(fetchFn, cfg, "POST", "/sessions", {
        agent: cfg.agent,
        messages: task,
        max_steps: cfg.maxSteps,
        max_time_s: cfg.maxTimeS,
        overrides: {
          "agent.answer_format": {
            type: "object",
            properties: {
              summary: { type: "string" },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sourceUrl: { type: "string" },
                    summary: { type: "string" },
                  },
                  required: ["sourceUrl", "summary"],
                },
              },
            },
            required: ["summary", "findings"],
          },
        },
      });
    },
    createTaskSession(task: string) {
      return req(fetchFn, cfg, "POST", "/sessions", {
        agent: cfg.agent,
        messages: task,
        max_steps: cfg.maxSteps,
        max_time_s: cfg.maxTimeS,
        overrides: {
          "agent.answer_format": {
            type: "object",
            properties: {
              summary: { type: "string" },
            },
            required: ["summary"],
          },
        },
      });
    },
    getChanges(sessionId: string, fromIndex: number, waitSeconds = 25) {
      return req(
        fetchFn, cfg, "GET",
        `/sessions/${sessionId}/changes?from_index=${fromIndex}&wait_for_seconds=${waitSeconds}`
      );
    },
    getSession(sessionId: string) {
      return req(fetchFn, cfg, "GET", `/sessions/${sessionId}`);
    },
    cancelSession(sessionId: string) {
      return req(fetchFn, cfg, "DELETE", `/sessions/${sessionId}`);
    },
  };
}
export type HClient = ReturnType<typeof createClient>;

export function toolsJson(): any {
  const p = fileURLToPath(new URL("../../../runtime/agent-image/tools.json", import.meta.url));
  return JSON.parse(readFileSync(p, "utf8"));
}

export function buildTask(subject: Subject, tools: any): string {
  const groups = Object.entries(tools.categories ?? {})
    .flatMap(([k, v]: any) => v.map((t: any) => `${k}: ${t.name} <${t.url}> - ${t.what}`))
    .join("\n");
  return `Research the person "${subject.name}" (a consenting participant; handles: ${(subject.handles ?? []).join(", ") || "n/a"}) using ONLY public information.
Restrict yourself to these approved source categories: ${subject.approvedSources.join(", ")}.
Rules: never log in, never bypass access controls or paywalls, never collect data about private third parties (family, friends, home address, private phone/email).
Suggested starting points (open in the browser as needed):
${groups}
Playbook: (1) start with Core search for the name plus any handles; (2) pivot — handle -> Username tools, name -> People/Public Records/Public Media; confirm identity by cross-referencing >=2 independent sources before recording a fact; (3) use Archiving (Wayback) for dead pages; (4) record each fact as a finding with the exact source URL; (5) skip anything revealing home address, phone, email, or family.
When you have gathered 6-12 durable facts, each with its source URL, finish with an answer object {summary, findings[]} where each finding is {sourceUrl, summary}.`;
}

export const OSINT_SOURCES = [
  "wikipedia", "news", "linkedin", "github", "twitter/x",
  "instagram", "personal-website", "public-records", "archive.org",
];

export function buildFreeformTask(task: string): string {
  return `Rules: use only public information; never log in, never bypass paywalls or access controls; make no purchases and no form submissions or other actions with real-world side effects; do not collect private information about private individuals.
Task: ${task}
When done, finish with an answer object {summary} containing a short plain-text result.`;
}
