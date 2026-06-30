// Clean-workspace compaction: generates a focused implementation handoff before execution starts.
// Uses pi's built-in serializeConversation where possible.

import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CLEAN_COMPACTION_MARKER } from "./identity.ts";
import type { PlanStep } from "./types.ts";

const DOSSIER_MAX_TOKENS = 6_000;
const MAX_HISTORY_CHARS = 80_000;

interface SelectedModel {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function resolveActiveModel(ctx: ExtensionContext): Promise<SelectedModel | undefined> {
  if (!ctx.model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (auth.ok === false) return undefined;
  return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if ((b.type === "tool_use" || b.type === "tool-call") && typeof b.name === "string") return `[tool:${b.name}] ${JSON.stringify(b.input ?? {})}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ── History serialization ────────────────────────────────

function serializeEntry(entry: SessionEntry): string | undefined {
  const e = entry as any;
  if (e.type === "message" && e.message) {
    const role = e.message.role ?? "message";
    const body = textFromContent(e.message.content);
    if (role === "toolResult") {
      return `<entry id="${e.id}" role="toolResult" tool="${e.message.toolName ?? "unknown"}">\n${body || JSON.stringify(e.message.details ?? {})}\n</entry>`;
    }
    return body ? `<entry id="${e.id}" role="${role}">\n${body}\n</entry>` : undefined;
  }
  if (e.type === "custom_message" && e.display !== false) {
    const body = textFromContent(e.content);
    return body ? `<entry id="${e.id}" role="custom:${e.customType ?? "unknown"}">\n${body}\n</entry>` : undefined;
  }
  if (e.type === "branch_summary" && e.summary) {
    return `<entry id="${e.id}" role="branch_summary">\n${e.summary}\n</entry>`;
  }
  return undefined;
}

function bounded(text: string, maxChars = MAX_HISTORY_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - maxChars} characters omitted from middle of planning history ...]\n\n${text.slice(text.length - tail)}`;
}

function serializePlanningHistory(entries: SessionEntry[]): string {
  const serialized = entries.map(serializeEntry).filter((value): value is string => Boolean(value)).join("\n\n");
  return bounded(serialized || "No planning conversation captured.");
}

// ── Marker detection ─────────────────────────────────────

export function isPrepareCleanCompaction(customInstructions?: string): boolean {
  return customInstructions?.includes(CLEAN_COMPACTION_MARKER) === true;
}

export function cleanCompactionInstructions(): string {
  // Leading planmode marker is an interoperability guard for older local compaction extensions
  // that know to step aside for pre-implementation handoffs.
  return `[planmode pre-implementation] ${CLEAN_COMPACTION_MARKER}
Create a focused implementation handoff for the approved prepare-mode plan. This marker is consumed by @taylorsatula/pi-prepare.`;
}

// ── File collection ──────────────────────────────────────

function collectReadFiles(entries: SessionEntry[]): string[] {
  const files = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const toolName = obj.toolName ?? obj.name;
    const input = obj.input ?? obj.args ?? obj.parameters;
    if (toolName === "read" && input && typeof input === "object") {
      const path = (input as Record<string, unknown>).path;
      if (typeof path === "string" && path.trim()) files.add(path.trim().replace(/^@/, ""));
    }
    for (const child of Object.values(obj)) visit(child);
  }
  for (const entry of entries) visit(entry);
  return [...files].sort();
}

// ── Dossier prompts ──────────────────────────────────────

function buildDossierSystemPrompt(): string {
  return `You generate a focused implementation dossier from a prepare-mode planning conversation.

Strict role:
- You are not the implementing agent.
- You are not writing a continuation summary.
- You distill forward-looking implementation context for the approved plan.
- Omit irrelevant files and irrelevant conversation aggressively.
- Preserve exact file paths and symbol names seen during planning.
- Do not invent facts.
- Do not restate the plan.
- Output plain text only, no wrapper tags, no code fences.

Output exactly these sections:
RELEVANT FILES:
Concise summaries of only files relevant to the plan, including why they matter. For each file: one sentence on what it contains and how it relates to the implementation.

CONSTRAINTS:
Synthesized architectural, convention, testing, and performance constraints shaping implementation. Extracted from the codebase exploration and any explicit requirements discussed.

SUPPORTING CONTEXT:
Non-obvious gotchas, rationale, unresolved issues, or interactions needed by the implementer. Things that aren't obvious from reading the plan alone but would cause mistakes if missed. Omit this section entirely if empty.`;
}

function buildApprovedPlanText(steps: PlanStep[]): string {
  return steps.map((s) => {
    let line = `### Step ${s.number} — ${s.title}\n`;
    if (s.what) line += `- What — ${s.what}\n`;
    if (s.files?.length) line += `- Files — ${s.files.join(", ")}\n`;
    if (s.details) line += `- Details — ${s.details}\n`;
    if (s.acceptanceCriteria) line += `- Acceptance Criteria — ${s.acceptanceCriteria}\n`;
    if (s.dependencies?.length) line += `- Dependencies — ${s.dependencies.join(", ")}\n`;
    return line;
  }).join("\n");
}

function buildDossierUserPrompt(input: {
  steps: PlanStep[];
  readFiles: string[];
  serializedConversation: string;
}): string {
  return `Approved plan (do not restate in output):
${buildApprovedPlanText(input.steps)}

Files read during planning:
${input.readFiles.length ? input.readFiles.map((f) => `- ${f}`).join("\n") : "None detected."}

Planning conversation:
${input.serializedConversation}`;
}

// ── Dossier generation ───────────────────────────────────

async function generateDossier(input: {
  selected: SelectedModel;
  steps: PlanStep[];
  readFiles: string[];
  serializedConversation: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await complete(
    input.selected.model,
    {
      systemPrompt: buildDossierSystemPrompt(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildDossierUserPrompt(input) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: input.selected.apiKey,
      headers: input.selected.headers,
      env: input.selected.env,
      maxTokens: Math.min(DOSSIER_MAX_TOKENS, input.selected.model.maxTokens || DOSSIER_MAX_TOKENS),
      signal: input.signal,
    },
  );
  if (response.stopReason === "error") throw new Error(response.errorMessage || "provider error");
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function wrapDossier(input: {
  firstKeptEntryId: string;
  tokensBefore: number;
  steps: PlanStep[];
  readFiles: string[];
  dossierBody: string;
}): string {
  return `PI PREPARE IMPLEMENTATION HANDOFF
firstKeptEntryId: ${input.firstKeptEntryId}
tokensBefore: ${input.tokensBefore}

Filesystem state remains authoritative. Reread files before editing; do not rely on this dossier as a substitute for current file contents.

APPROVED PLAN:
${buildApprovedPlanText(input.steps)}

IMPLEMENTATION DOSSIER:
${input.dossierBody}

FILES READ DURING PLANNING:
${input.readFiles.length ? input.readFiles.map((f) => `- ${f}`).join("\n") : "None detected."}`;
}

// ── Public API ───────────────────────────────────────────

export async function buildPrepareCompaction(input: {
  ctx: ExtensionContext;
  branchEntries: SessionEntry[];
  firstKeptEntryId: string;
  tokensBefore: number;
  todos: PlanStep[];
  signal: AbortSignal;
}): Promise<{ summary: string; details: Record<string, unknown> } | undefined> {
  if (input.todos.length === 0) return undefined;

  const selected = await resolveActiveModel(input.ctx);
  if (!selected) {
    notify(input.ctx, "prepare: no model/auth for prepare dossier; using Pi default compaction", "warning");
    return undefined;
  }

  const readFiles = collectReadFiles(input.branchEntries);
  const serializedConversation = serializePlanningHistory(input.branchEntries);

  const dossierBody = await generateDossier({
    selected,
    steps: input.todos,
    readFiles,
    serializedConversation,
    signal: input.signal,
  });

  if (!dossierBody.trim()) {
    notify(input.ctx, "prepare: dossier model returned empty text; using Pi default compaction", "warning");
    return undefined;
  }

  return {
    summary: wrapDossier({
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      steps: input.todos,
      readFiles,
      dossierBody,
    }),
    details: {
      kind: "pi-prepare-dossier",
      generatedAt: new Date().toISOString(),
      model: `${selected.model.provider}/${selected.model.id}`,
      readFiles,
      planSteps: input.todos,
    },
  };
}

