// Interactive clarifying questions tool — always available regardless of phase.
// Renders an interactive TUI widget for single or multi-question surveys.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Answer, Question, QuestionnaireResult, QuestionOption } from "./types.ts";

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "Stable answer value returned to the agent" }),
  label: Type.String({ description: "Display label for this option" }),
  description: Type.Optional(Type.String({ description: "Optional explanatory text" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Stable answer identifier" }),
  label: Type.Optional(Type.String({ description: "Short display/tab label" })),
  prompt: Type.String({ description: "Full question text" }),
  options: Type.Array(QuestionOptionSchema, { description: "Selectable answers" }),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-text answer (default true)" })),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

type RenderOption = QuestionOption & { isOther?: boolean };

function errorResult(message: string, questions: Question[] = []): {
  content: Array<{ type: "text"; text: string }>;
  details: QuestionnaireResult;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

export function installQuestionnaireTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more clarifying questions through the interactive UI. Each question supports radio options plus an always-available free-text option (allowOther defaults true). Use this in prepare mode when requirements, scope, or preferences are ambiguous.",
    promptSnippet: "Ask the user structured clarifying questions in prepare mode; every question offers a free-text option by default",
    promptGuidelines: [
      "Use questionnaire during prepare mode when a user decision is needed before submitting a plan.",
      "Every question automatically includes a free-text option unless allowOther is set to false — the user can always type their own answer.",
    ],
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return errorResult("Questionnaire cancelled: interactive TUI mode is required.");
      }
      if (!Array.isArray(params.questions) || params.questions.length === 0) {
        return errorResult("Questionnaire cancelled: no questions were provided.");
      }

      const questions: Question[] = params.questions.map((q, i) => ({
        id: q.id,
        label: q.label || `Q${i + 1}`,
        prompt: q.prompt,
        options: q.options ?? [],
        allowOther: q.allowOther !== false, // always-on freeform option
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1;

      const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }
        function submit(cancelled: boolean) {
          done({ questions, answers: Array.from(answers.values()), cancelled });
        }
        function currentQuestion(): Question | undefined {
          return questions[currentTab];
        }
        function currentOptions(): RenderOption[] {
          const q = currentQuestion();
          if (!q) return [];
          const opts: RenderOption[] = [...q.options];
          if (q.allowOther) opts.push({ value: "__other__", label: "Type something", isOther: true });
          return opts;
        }
        function allAnswered(): boolean {
          return questions.every((q) => answers.has(q.id));
        }
        function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
          answers.set(questionId, { id: questionId, value, label, wasCustom, index });
        }
        function advanceAfterAnswer() {
          if (!isMulti) {
            submit(false);
            return;
          }
          currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length;
          optionIndex = 0;
          refresh();
        }

        editor.onSubmit = (value) => {
          if (!inputQuestionId) return;
          const trimmed = value.trim() || "(no response)";
          saveAnswer(inputQuestionId, trimmed, trimmed, true);
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          advanceAfterAnswer();
        };

        function handleInput(data: string) {
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              inputQuestionId = null;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = currentQuestion();
          const opts = currentOptions();
          if (isMulti) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
          }
          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
            else if (matchesKey(data, Key.escape)) submit(true);
            return;
          }
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter) && q && opts[optionIndex]) {
            const opt = opts[optionIndex];
            if (opt.isOther) {
              inputMode = true;
              inputQuestionId = q.id;
              editor.setText("");
              refresh();
              return;
            }
            saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
            advanceAfterAnswer();
            return;
          }
          if (matchesKey(data, Key.escape)) submit(true);
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;
          const lines: string[] = [];
          const renderWidth = Math.max(1, width);
          const q = currentQuestion();
          const opts = currentOptions();
          function addWrapped(text: string) { lines.push(...wrapTextWithAnsi(text, renderWidth)); }
          function addWrappedWithPrefix(prefix: string, text: string) {
            const prefixWidth = visibleWidth(prefix);
            const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
            const continuationPrefix = " ".repeat(prefixWidth);
            for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
          }

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          if (isMulti) {
            const tabs: string[] = [];
            for (let i = 0; i < questions.length; i++) {
              const active = i === currentTab;
              const answered = answers.has(questions[i].id);
              const text = ` ${answered ? "■" : "□"} ${questions[i].label} `;
              tabs.push(active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text));
            }
            const submitText = " ✓ Submit ";
            tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText));
            addWrappedWithPrefix(" ", tabs.join(" "));
            lines.push("");
          }

          function renderOptions() {
            for (let i = 0; i < opts.length; i++) {
              const opt = opts[i];
              const selected = i === optionIndex;
              addWrappedWithPrefix(selected ? theme.fg("accent", "> ") : "  ", theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`));
              if (opt.description) addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
            }
          }

          if (inputMode && q) {
            addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
            lines.push("");
            renderOptions();
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
            for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter submit • Esc cancel"));
          } else if (currentTab === questions.length) {
            addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
            lines.push("");
            for (const question of questions) {
              const answer = answers.get(question.id);
              if (answer) addWrappedWithPrefix(" ", `${theme.fg("muted", `${question.label}: `)}${answer.label}`);
            }
            lines.push("");
            addWrappedWithPrefix(" ", allAnswered() ? theme.fg("success", "Press Enter to submit") : theme.fg("warning", "Answer all questions before submitting"));
          } else if (q) {
            addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
            lines.push("");
            renderOptions();
          }
          lines.push("");
          if (!inputMode) addWrappedWithPrefix(" ", theme.fg("dim", isMulti ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : "↑↓ select • Enter confirm • Esc cancel"));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedLines = lines;
          return lines;
        }

        return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
      });

      if (result.cancelled) return { content: [{ type: "text", text: "User cancelled the questionnaire." }], details: result };
      const answerText = result.answers.map((answer) => {
        const label = questions.find((q) => q.id === answer.id)?.label ?? answer.id;
        return answer.wasCustom ? `${label}: user wrote: ${answer.label}` : `${label}: user selected: ${answer.index}. ${answer.label}`;
      }).join("\n");
      return { content: [{ type: "text", text: answerText }], details: result };
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      let text = theme.fg("toolTitle", theme.bold("questionnaire ")) + theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`);
      const labels = qs.map((q) => q.label || q.id).filter(Boolean).join(", ");
      if (labels) text += theme.fg("dim", ` (${labels})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Questionnaire cancelled"), 0, 0);
      return new Text(details.answers.map((answer) => `${theme.fg("success", "✓")} ${theme.fg("accent", answer.id)}: ${answer.label}`).join("\n"), 0, 0);
    },
  });
}

