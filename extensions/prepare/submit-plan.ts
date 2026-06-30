// propose_completed_plan — signals that the agent's plan is ready for user review.
// Takes zero parameters; the plan is whatever prose was written above.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PreparedPlan } from "./types.ts";

export interface SubmitPlanState {
  pendingPlan?: PreparedPlan;
}

export function installProposeCompletedPlanTool(pi: ExtensionAPI, state: SubmitPlanState): void {
  pi.registerTool({
    name: "propose_completed_plan",
    label: "Submit Plan",
    description:
      "Signal that your implementation plan is ready for user review. Call this after you have written the plan as a natural response above — the system will capture it and present it to the user with accept/deny options. Takes no parameters; the plan is whatever you wrote above.",
    promptSnippet: "Signal that the implementation plan is ready for user approval",
    promptGuidelines: [
      "Write the plan as a rich, detailed response first (exploration trail, root cause analysis, key changes, test plan, correctness justification), then call propose_completed_plan as the explicit gate to user review.",
      "Do not pass structured data here — just signal readiness. The plan is whatever you wrote above.",
    ],
    parameters: {},

    async execute(_toolCallId, _params) {
      state.pendingPlan = { rawText: "", steps: [] };
      return {
        content: [{ type: "text" as const, text: "Plan submitted for user review." }],
        details: {},
        terminate: true,
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("propose_completed_plan")), 0, 0);
    },

    renderResult(result, _options, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "Plan submitted";
      return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
    },
  });
}

