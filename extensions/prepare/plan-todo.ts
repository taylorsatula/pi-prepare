// plan_todo — tracks step completion during execution phase.
// Actions: list (show all steps with status), complete (mark a step done).

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PlanStep } from "./types.ts";

const ParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("complete"),
    Type.Literal("cancel"),
  ], { description: "Action to perform: 'list' shows all steps, 'complete' marks one done, 'cancel' clears the plan" }),
  stepId: Type.Optional(Type.String({ description: "Step ID to mark complete (required for 'complete' action)" })),
});

function formatStep(step: PlanStep): string {
  const marker = step.completed ? "[x]" : "[ ]";
  let line = `${marker} ${step.number}. ${step.title}`;
  if (step.files?.length) line += ` (${step.files.join(", ")})`;
  if (step.dependencies?.length) line += ` [depends: ${step.dependencies.join(", ")}]`;
  return line;
}

export function installPlanTodoTool(pi: ExtensionAPI, stepsRef: { current: PlanStep[] }): void {
  pi.registerTool({
    name: "plan_todo",
    label: "Plan Todo",
    description:
      "Track progress on the approved implementation plan. Use 'list' to see all steps and their status, or 'complete' to mark a step as done when its work is finished.",
    promptSnippet: "Track implementation progress via the plan todo list",
    promptGuidelines: [
      "Call plan_todo(action: 'list') at the start of execution to review remaining steps.",
      "Call plan_todo(action: 'complete', stepId: 'step-N') only after the step is actually complete.",
      "Do not call plan_todo until the step's acceptance criteria are met.",
      "Call plan_todo(action: 'cancel') only if the plan can no longer proceed and must be abandoned.",
    ],
    parameters: ParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = params.action as "list" | "complete" | "cancel";
      const steps = stepsRef.current;

      if (action === "list") {
        const lines = steps.map(formatStep);
        const completed = steps.filter((s) => s.completed).length;
        const header = `Plan Progress: ${completed}/${steps.length} steps complete`;
        return {
          content: [{ type: "text" as const, text: `${header}\n\n${lines.join("\n")}` }],
          details: { steps },
        };
      }

      if (action === "cancel") {
        stepsRef.current = [];
        return {
          content: [{ type: "text" as const, text: "Plan cancelled. All steps cleared." }],
          details: { steps: [] },
        };
      }

      // complete
      const stepId = params.stepId as string | undefined;
      if (!stepId) {
        return {
          content: [{ type: "text" as const, text: "Error: stepId is required for 'complete' action." }],
          details: { steps },
        };
      }
      const target = steps.find((s) => s.id === stepId);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `Error: step '${stepId}' not found.` }],
          details: { steps },
        };
      }
      target.completed = true;
      return {
        content: [{ type: "text" as const, text: `Step ${target.number} "${target.title}" marked complete.` }],
        details: { steps },
      };
    },

    renderCall(args, theme) {
      const action = (args.action as string) || "list";
      const stepId = args.stepId as string | undefined;
      let text = theme.fg("toolTitle", theme.bold("plan_todo ")) + theme.fg("muted", action);
      if (stepId && action === "complete") {
        text += theme.fg("accent", ` ${stepId}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      if (text.startsWith("Error:")) {
        return new Text(theme.fg("error", text), 0, 0);
      }
      if (text.includes("marked complete")) {
        return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
      }
      // list output — render with theming
      const lines = text.split("\n");
      const themedLines = lines.map((line) => {
        if (line.startsWith("[x]")) return theme.fg("success", line);
        if (line.startsWith("[ ]")) return theme.fg("text", line);
        if (line.includes("Progress:")) return theme.fg("accent", line);
        return line;
      });
      return new Text(themedLines.join("\n"), 0, 0);
    },
  });
}

