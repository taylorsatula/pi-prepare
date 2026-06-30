// Prepare extension — three-phase linear flow: idle → preparing → executing → idle.
// Structured tool calls replace brittle prose-scraping and [DONE:n] pattern-matching.

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { checkBashSafety } from "./bash-safety.ts";
import {
  buildPrepareCompaction,
  cleanCompactionInstructions,
  isPrepareCleanCompaction,
} from "./dossier.ts";
import {
  EXECUTION_CONTEXT_TYPE,
  PLANNING_CONTEXT_TYPE,
  STATE_CUSTOM_TYPE,
} from "./identity.ts";
import { installPlanTodoTool } from "./plan-todo.ts";
import {
  buildExecutionInstruction,
  buildHudSectionContent,
  buildPlanningInstruction,
  formatStepForDisplay,
  PREPARE_TOOLS,
  EXECUTION_TOOLS,
} from "./prompts.ts";
import { installQuestionnaireTool } from "./questionnaire.ts";
import { installProposeCompletedPlanTool, type SubmitPlanState } from "./submit-plan.ts";
import type { PreparedPlan, PlanStep, PreparePhase, PrepareState } from "./types.ts";

const STATUS_KEY = "prepare";
const WIDGET_KEY = "prepare-todos";

// ── Shared mutable state ────────────────────────────────

const state: PrepareState = { phase: "idle", plan: null };
const submitPlanState: SubmitPlanState = {};
const stepsRef: { current: PlanStep[] } = { current: [] };

let defaultTools: string[] | undefined;

// ── Plan parsing ────────────────────────────────────────

function parsePlan(rawText: string): PlanStep[] {
  const lines = rawText.split(/\r?\n/);
  const steps: PlanStep[] = [];
  let i = 0;

  while (i < lines.length) {
    // Match ### Step N — Title
    const match = lines[i].match(/^#{1,6}\s+Step\s+(\d+)\s*—\s*(.+)$/i);
    if (!match) { i++; continue; }

    const number = Number(match[1]);
    const title = match[2].trim();
    const id = `step-${number}`;

    // Parse bullet fields until next ### Step or end of text
    let what: string | undefined;
    let files: string[] | undefined;
    let details: string | undefined;
    let acceptanceCriteria: string | undefined;
    let dependencies: string[] | undefined;

    i++;
    while (i < lines.length && !/^#{1,6}\s+Step\s+\d+\s*—/i.test(lines[i])) {
      const line = lines[i];
      const fieldMatch = line.match(/^-\s*(What|Files|Details|Acceptance Criteria|Dependencies)\s*[—–-]\s*(.+)$/i);
      if (fieldMatch) {
        const fieldName = fieldMatch[1].toLowerCase().replace(/\s/g, "");
        const value = fieldMatch[2].trim();
        switch (fieldName) {
          case "what": what = value; break;
          case "files": files = value.split(",").map((f) => f.trim()).filter(Boolean); break;
          case "details": details = value; break;
          case "acceptancecriteria": acceptanceCriteria = value; break;
          case "dependencies": dependencies = value.split(",").map((d) => d.trim()).filter(Boolean); break;
        }
      }
      i++;
    }

    steps.push({ id, number, title, what, files, details, acceptanceCriteria, dependencies, completed: false });
  }

  // Fallback: single catch-all step if no numbered steps found
  if (steps.length === 0) {
    return [{ id: "step-1", number: 1, title: "Execute the approved plan", completed: false }];
  }
  return steps;
}

// ── Phase transitions ───────────────────────────────────

function enterPreparing(pi: ExtensionAPI, ctx: ExtensionContext): void {
  state.phase = "preparing";
  state.plan = null;
  stepsRef.current = [];

  // Tool swap: remove edit/write, add propose_completed_plan + questionnaire
  if (!defaultTools) defaultTools = pi.getActiveTools();
  const active = pi.getActiveTools();
  const newActive = active.filter((t) => t !== "edit" && t !== "write");
  if (!newActive.includes("propose_completed_plan")) newActive.push("propose_completed_plan");
  if (!newActive.includes("questionnaire")) newActive.push("questionnaire");
  pi.setActiveTools(newActive);

  updateUi(ctx);
  if (ctx.hasUI) ctx.ui.notify(`Prepare mode enabled. Tools: ${PREPARE_TOOLS.join(", ")}`, "info");
}

function enterExecuting(pi: ExtensionAPI, ctx: ExtensionContext): void {
  state.phase = "executing";

  // Tool swap: remove propose_completed_plan, add plan_todo
  const active = pi.getActiveTools();
  const newActive = active.filter((t) => t !== "propose_completed_plan" && t !== "questionnaire");
  if (!newActive.includes("plan_todo")) newActive.push("plan_todo");
  // Ensure execution tools are present
  for (const tool of EXECUTION_TOOLS) {
    if (!newActive.includes(tool)) newActive.push(tool);
  }
  pi.setActiveTools(newActive);

  // Seed steps from parsed plan
  if (state.plan?.steps) {
    stepsRef.current = state.plan.steps.map((s) => ({ ...s, completed: false }));
  }

  // Contribute HUD section showing current step
  pi.events.emit("hud_section", {
    id: "prepare-current-step",
    label: "Step",
    async render(): Promise<string | null> {
      return buildHudSectionContent(state.phase, stepsRef.current);
    },
  });

  updateUi(ctx);
}

function enterIdle(pi: ExtensionAPI, ctx: ExtensionContext, message?: string): void {
  state.phase = "idle";
  state.plan = null;
  stepsRef.current = [];

  // Restore default tools
  if (defaultTools) {
    pi.setActiveTools(defaultTools);
    defaultTools = undefined;
  }

  updateUi(ctx);
  if (message && ctx.hasUI) ctx.ui.notify(message, "info");
}

// ── UI helpers ──────────────────────────────────────────

function updateUi(ctx: ExtensionContext): void {
  if (state.phase === "preparing") {
    ctx.ui.setStatus(STATUS_KEY, "prepare");
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  if (state.phase === "executing" && stepsRef.current.length > 0) {
    const completed = stepsRef.current.filter((s) => s.completed).length;
    ctx.ui.setStatus(STATUS_KEY, `prepare ${completed}/${stepsRef.current.length}`);
    ctx.ui.setWidget(
      WIDGET_KEY,
      stepsRef.current.map(formatStepForDisplay),
      { placement: "aboveEditor" },
    );
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function isPrepareContextMessage(message: unknown): boolean {
  const candidate = message as { customType?: string; role?: string; content?: unknown };
  if (candidate.customType === PLANNING_CONTEXT_TYPE || candidate.customType === EXECUTION_CONTEXT_TYPE) {
    return true;
  }
  if (candidate.role !== "user") return false;
  const content = candidate.content;
  if (typeof content === "string") return content.includes("[PREPARE MODE ACTIVE]");
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: string; text?: unknown };
    return b.type === "text" && typeof b.text === "string" && b.text.includes("[PREPARE MODE ACTIVE]");
  });
}

// ── Plan review dialog ──────────────────────────────────

async function reviewSubmittedPlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  eventMessages: unknown[],
): Promise<void> {
  const pending = submitPlanState.pendingPlan;
  if (!pending) return;
  submitPlanState.pendingPlan = undefined;

  // Capture the agent's last assistant text as the raw plan
  let planText = pending.rawText;
  if (!planText.trim()) {
    planText = lastAssistantTextFromMessages(eventMessages) ??
      lastAssistantTextFromSession(ctx) ??
      "(no plan text captured)";
  }

  // Parse structured steps from the plan text
  const parsedSteps = parsePlan(planText);
  state.plan = { rawText: planText, steps: parsedSteps };

  // Persist the chosen plan once
  pi.appendEntry(STATE_CUSTOM_TYPE, { rawText: planText, steps: parsedSteps });

  // Show review dialog
  if (!ctx.hasUI) return;
  const choice = await ctx.ui.select("Prepare mode — Review Plan", [
    "Clean Workspace & Implement",
    "Implement",
    "Keep Refining",
    "Cancel",
  ]);

  switch (choice) {
    case "Clean Workspace & Implement": {
      enterExecuting(pi, ctx);
      ctx.ui.notify("Preparing clean implementation handoff...", "info");
      ctx.compact({
        customInstructions: cleanCompactionInstructions(),
        onComplete: () => startExecutionTurn(pi),
        onError: (error) => {
          ctx.ui.notify(`Prepare compaction failed: ${error.message}. Starting execution without clean handoff.`, "warning");
          startExecutionTurn(pi);
        },
      });
      break;
    }
    case "Implement": {
      enterExecuting(pi, ctx);
      startExecutionTurn(pi);
      break;
    }
    case "Keep Refining": {
      // Stay in preparing phase, return to chat
      updateUi(ctx);
      break;
    }
    case "Cancel": {
      enterIdle(pi, ctx, "Prepare mode cancelled.");
      break;
    }
  }
}

// ── Execution kickoff ───────────────────────────────────

function startExecutionTurn(pi: ExtensionAPI): void {
  const first = stepsRef.current.find((s) => !s.completed);
  const kickoff = first
    ? `Execute the approved plan. Begin with step ${first.number}: ${first.title}. Use plan_todo(action: "complete", stepId: "${first.id}") when done.`
    : "Execute the approved plan. Use plan_todo to track progress.";
  pi.sendMessage({ customType: "pi-prepare-execution-start", content: kickoff, display: true }, { triggerTurn: true });
}

// ── Completion check ────────────────────────────────────

function completeIfDone(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (state.phase !== "executing" || stepsRef.current.length === 0) return;
  if (!stepsRef.current.every((s) => s.completed)) return;

  const completed = stepsRef.current.map((s) => `- ${s.title}`).join("\n");
  pi.sendMessage(
    { customType: "pi-prepare-plan-complete", content: `Prepare plan complete.\n\n${completed}`, display: true },
    { triggerTurn: false },
  );
  enterIdle(pi, ctx, "All prepare steps completed!");
}

// ── Helpers ─────────────────────────────────────────────

function lastAssistantTextFromMessages(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantText(messages[i]);
    if (text.trim()) return text;
  }
  return undefined;
}

function lastAssistantTextFromSession(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const text = assistantText(entry.message);
    if (text.trim()) return text;
  }
  return undefined;
}

function assistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    )
    .map((block) => block.text)
    .join("\n");
}

// ── Main extension ──────────────────────────────────────

export default function prepareExtension(pi: ExtensionAPI): void {
  // Flag
  pi.registerFlag("prepare", {
    description: "Start in prepare mode (read-only planning)",
    type: "boolean",
    default: false,
  });

  // Tools
  installQuestionnaireTool(pi);
  installProposeCompletedPlanTool(pi, submitPlanState);
  installPlanTodoTool(pi, stepsRef);

  // Commands
  pi.registerCommand("prepare", {
    description: "Toggle prepare mode",
    handler: async (_args, ctx) => {
      if (state.phase === "preparing") {
        enterIdle(pi, ctx, "Prepare mode disabled.");
        return;
      }
      enterPreparing(pi, ctx);
    },
  });

  pi.registerCommand("todos", {
    description: "Show prepare plan progress",
    handler: async (_args, ctx) => {
      if (stepsRef.current.length === 0) {
        ctx.ui.notify("No prepare todos.", "info");
        return;
      }
      const lines = stepsRef.current.map(formatStepForDisplay).join("\n");
      ctx.ui.notify(lines, "info");
    },
  });

  // Shortcut
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle prepare mode",
    handler: async (ctx) => {
      if (state.phase === "preparing") {
        enterIdle(pi, ctx, "Prepare mode disabled.");
        return;
      }
      enterPreparing(pi, ctx);
    },
  });

  // ── Event hooks ───────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    // Capture default tools on session start
    defaultTools = pi.getActiveTools();

    // Reset to idle on new session
    state.phase = "idle";
    state.plan = null;
    stepsRef.current = [];

    // If --prepare flag set, enter preparing phase
    if (pi.getFlag("prepare") === true) {
      enterPreparing(pi, ctx);
    }
    updateUi(ctx);
  });

  pi.on("before_agent_start", () => {
    if (state.phase === "preparing") {
      return {
        message: {
          customType: PLANNING_CONTEXT_TYPE,
          content: buildPlanningInstruction(),
          display: false,
        },
      };
    }
    if (state.phase === "executing" && stepsRef.current.length > 0) {
      return {
        message: {
          customType: EXECUTION_CONTEXT_TYPE,
          content: buildExecutionInstruction(stepsRef.current),
          display: false,
        },
      };
    }
  });

  pi.on("context", (event) => {
    if (state.phase !== "idle") return;
    return {
      messages: event.messages.filter((message) => !isPrepareContextMessage(message)),
    };
  });

  pi.on("tool_call", (event) => {
    if (state.phase === "preparing") {
      // Block non-prepare tools
      const allowed = [...PREPARE_TOOLS, "propose_completed_plan"];
      if (!allowed.includes(event.toolName)) {
        return {
          block: true,
          reason: `Prepare mode: ${event.toolName} is not available. Submit or cancel the plan before editing.`,
        };
      }
      // Bash safety gate
      if (isToolCallEventType("bash", event)) {
        const result = checkBashSafety(event.input.command);
        if (!result.safe) {
          return {
            block: true,
            reason: `Prepare mode: bash command blocked (${result.reason}).`,
          };
        }
      }
    }
    if (state.phase === "executing") {
      // Allow execution tools + plan_todo + questionnaire (always available)
      if (event.toolName === "questionnaire") return;
      const allowed = [...EXECUTION_TOOLS, "plan_todo"];
      if (!allowed.includes(event.toolName)) {
        return {
          block: true,
          reason: `Execute mode: ${event.toolName} is not available during execution.`,
        };
      }
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (state.phase === "executing") {
      completeIfDone(pi, ctx);
      return;
    }
    if (state.phase !== "preparing") return;
    await reviewSubmittedPlan(pi, ctx, event.messages);
  });

  pi.on("turn_end", (event, ctx) => {
    if (state.phase !== "executing" || stepsRef.current.length === 0) return;
    updateUi(ctx);
    completeIfDone(pi, ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!isPrepareCleanCompaction(event.customInstructions)) return;
    if (stepsRef.current.length === 0) return;

    // Drop all entries — the dossier summary replaces everything.
    const firstKeptEntryId = "999999";
    const result = await buildPrepareCompaction({
      ctx,
      branchEntries: event.branchEntries,
      firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      todos: stepsRef.current,
      signal: event.signal,
    });
    if (!result) return;
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: result.details,
      },
    };
  });
}

