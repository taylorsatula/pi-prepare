// Prompt builders for preparing and executing phases.
// Text is embedded here so the extension does not depend on external files.

import type { PlanStep, PreparePhase, PrepareState } from "./types.ts";

export const PREPARE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "propose_completed_plan"];
export const EXECUTION_TOOLS = ["read", "bash", "edit", "write"];

function planningInstruction(): string {
  return `[PREPARE MODE ACTIVE]
You are in Pi prepare mode: a read-only planning phase.

## Restrictions

| Rule | Detail |
|------|--------|
| Tools | Only: ${PREPARE_TOOLS.join(", ")} |
| Files | Read-only. No edit, write, or file-creation tools. |
| Bash | Allowlist-gated. Prefer read/grep/find/ls. No redirection, no mutations, no side effects. |
| Blocked | git mutations, npm/pnpm install, sed -i, find -exec, curl -o, package publish |

## Workflow

1. **Explore** — Read files, grep symbols, understand the codebase. Ground every claim in actual code.
2. **Clarify** — Use \`questionnaire\` when requirements are ambiguous. Every question has a free-text option.
3. **Write the plan** — Write a complete plan as your response text, following the format below. The plan IS your response—there is no separate submission payload.
4. **Submit** — After you have finished writing the plan text, call \`propose_completed_plan()\` as the final tool call in your turn. It takes zero parameters. It signals "my plan is ready for review" and ends the turn. The system captures whatever you wrote above the tool call as the plan.

> **When to call \`propose_completed_plan\`:** Only after the full plan is written out in your response. Not before. Not in a separate turn. Write first, then call the tool as the last action. If you need more exploration or clarification, do that in earlier turns—don't submit until the plan is complete.

## Plan Format

Write a decision-complete plan with these sections, in order:

### Decisions

Bulleted list. One decision per line. Each states the choice and the constraint it satisfies.
- Example: \`State: in-memory only — crash recovery is not a goal\`
- Example: \`Auth: OAuth2 PKCE — server-side secrets unavailable\`

### Types

Declare key interfaces, types, enums, and constants as code blocks. The implementer should be able to copy-paste these directly. Only include types central to the design—not every helper.

### Architecture

Brief description of component boundaries, data flow, and integration points. Use tables or bullet lists—not prose paragraphs. A diagram (ASCII or Mermaid) is welcome if it clarifies wiring.

### Implementation Steps

Ordered, numbered. Each step is self-contained—someone unfamiliar with the project can pick up step N and execute it independently.

Format each step exactly like this (the system parses these headers):

\`\`\`
### Step 1 — [Step Title]

- What — What changes and why. Be specific, not hand-wavy.
- Files — Exact paths to create or modify (e.g. src/api/routes.ts)
- Details — Name the functions, types, fields involved. Describe mechanics: what gets added, removed, restructured. No hand-waving ("set up the foundation"), no over-specifying constants you'd determine during implementation.
- Acceptance Criteria — Concrete, objectively checkable conditions proving this step is done.
- Dependencies — Which prior steps must complete first, or "None".
\`\`\`

Rules for steps:
- Sequential numbering starting from 1. No gaps.
- Use the exact \`### Step N — Title\` header format.
- Each step should take roughly 1 focused agent turn to complete.
- If two changes are tightly coupled, combine them into one step rather than creating a dependency chain.

## After Approval

- You will execute the plan with full editing tools restored.
- Track progress: \`plan_todo(action: "complete", stepId: "step-N")\` after each step.
- Reread files before editing—filesystem state is authoritative.`;
}

function executionInstruction(steps: PlanStep[]): string {
  const approvedSteps = steps.map(formatStepForDisplay).join("\n");
  const remainingSteps = steps.filter((s) => !s.completed).map(formatStepForDisplay).join("\n") || "None.";
  return `[PREPARE EXECUTION MODE]
You are executing an approved implementation plan. Normal implementation tools are restored.

Approved plan:
${approvedSteps}

Remaining steps:
${remainingSteps}

Rules:
- Execute the approved plan in dependency/order-aware sequence.
- Reread files before editing; filesystem state is authoritative.
- When you complete a step, call plan_todo(action: "complete", stepId: "step-N") where N is the step number.
- Do not call plan_todo until the step is actually complete.
- If new information requires changing the plan, explain the issue and ask the user before diverging materially.`;
}

export function buildPlanningInstruction(): string {
  return planningInstruction();
}

export function buildExecutionInstruction(steps: PlanStep[]): string {
  return executionInstruction(steps);
}

// ── Formatters ───────────────────────────────────────────

export function formatStepForDisplay(step: PlanStep): string {
  const marker = step.completed ? "[x]" : "[ ]";
  let line = `${marker} ${step.number}. ${step.title}`;
  if (step.files?.length) line += ` (${step.files.join(", ")})`;
  if (step.dependencies?.length) line += ` [depends: ${step.dependencies.join(", ")}]`;
  return line;
}

export function describeStep(step: PlanStep): string {
  // Compact single-line version for HUD injection
  const parts = [`${step.number}. ${step.title}`];
  if (step.what) parts.push(step.what.split("\n")[0]);
  return parts.join(" — ");
}

export function buildHudSectionContent(phase: PreparePhase, steps: PlanStep[]): string | null {
  if (phase !== "executing" || steps.length === 0) return null;
  const current = steps.find((s) => !s.completed);
  if (!current) return null;
  const lines = [`▶ Step ${current.number}: ${current.title}`];
  if (current.what) lines.push(current.what.split("\n")[0]);
  if (current.files?.length) lines.push(`Files: ${current.files.join(", ")}`);
  return lines.join(" | ");
}

