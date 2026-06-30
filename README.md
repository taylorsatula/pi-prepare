# @taylorsatula/pi-prepare

Read-only prepare mode for Pi with clarifying questions, structured plan approval, tracked execution, and clean-workspace implementation dossiers.

## Overview

A three-phase linear workflow extension for Pi:

1. **Preparing** — Read-only exploration phase. The agent reads code, asks clarifying questions via an interactive TUI questionnaire, writes a structured plan, and submits it via `propose_completed_plan`.
2. **Executing** — Full editing tools restored. The agent executes the approved plan step-by-step, tracking progress with `plan_todo`.
3. **Idle** — Default state when prepare mode is off.

## Installation

```bash
# Via pi packages
pi add github.com/taylorsatula/pi-prepare
```

Or install locally by placing this directory under `~/.pi/packages/prepare/`.

## Usage

### Start Prepare Mode

- Run `/prepare` or press `Ctrl+Alt+P` to toggle prepare mode on/off.
- Pass `--prepare` flag to start directly in preparing phase:
  ```bash
  pi --prepare "implement feature X"
  ```

### Preparing Phase

During preparation, the agent operates in read-only mode:

- **Allowed tools**: `read`, `bash` (allowlist-gated), `grep`, `find`, `ls`, `questionnaire`, `propose_completed_plan`
- **Blocked**: `edit`, `write`, mutating bash commands (git mutations, npm install, sed -i, find -exec, curl -o, etc.)
- **Bash safety gate**: Commands are validated against an allowlist with special handling for git, npm/pnpm/yarn, sed/awk, find, and curl/wget

The agent should:
1. Explore the codebase using read/grep/find/ls
2. Ask clarifying questions via `questionnaire` when requirements are ambiguous
3. Write a complete plan following the prescribed format (Decisions → Types → Architecture → Implementation Steps)
4. Submit the plan by calling `propose_completed_plan()` as the final action

### Plan Review Dialog

After submission, the user sees four options:

| Choice | Behavior |
|--------|----------|
| Clean Workspace & Implement | Compacts the conversation into an AI-generated implementation dossier, then starts execution with a clean context window |
| Implement | Starts execution without compaction — full planning history remains in context |
| Keep Refining | Returns to chat for further discussion before resubmitting |
| Cancel | Exits prepare mode entirely |

### Executing Phase

During execution, the agent has full editing capabilities:

- **Allowed tools**: `read`, `bash`, `edit`, `write`, `plan_todo`
- Progress is tracked via `plan_todo(action: "complete", stepId: "step-N")` after each step
- A HUD section displays the current step being executed
- Status bar shows completion progress (e.g., `prepare 2/5`)

### Commands

| Command | Description |
|---------|-------------|
| `/prepare` | Toggle prepare mode on/off |
| `/todos` | Show current plan progress |

## Architecture

### File Structure

```
extensions/prepare/
├── index.ts          # Main extension entry point — flags, commands, shortcuts, event hooks, phase transitions
├── types.ts           # Core type definitions (PreparePhase, PlanStep, PreparedPlan, QuestionnaireResult)
├── identity.ts        # Constants — custom type strings for context messages and compaction markers
├── prompts.ts         # Prompt builders for planning/execution instructions + step formatters
├── bash-safety.ts     # Read-only bash command validation gate with per-command allowlists
├── dossier.ts         # Clean-workspace compaction — AI-generated implementation handoff dossier
├── plan-todo.ts       # plan_todo tool — tracks step completion during execution
├── questionnaire.ts   # Interactive TUI widget for multi-question surveys with radio + free-text input
└── submit-plan.ts     # propose_completed_plan tool — signals plan readiness for user review
```

### Key Design Decisions

- **Tool swapping over blocking**: Instead of intercepting every tool call, the extension swaps active tools at phase boundaries — edit/write are removed during preparing, and propose_completed_plan/questionnaire are added back during executing.
- **Structured plan parsing**: Plans are parsed from markdown using `### Step N — Title` headers with bullet fields (What, Files, Details, Acceptance Criteria, Dependencies). Falls back to a single catch-all step if no numbered steps are found.
- **Clean workspace compaction**: When selected, the entire planning conversation is serialized and sent to the active model to generate a focused implementation dossier (relevant files, constraints, supporting context) that replaces all previous entries in the context window.
- **Bash safety gate**: Allowlist-based command checking with granular subcommand rules for git (blocks mutating operations like commit/push/rebase), package managers (blocks install/add/remove), sed/awk (blocks -i), find (blocks -exec/-delete), and curl/wget (blocks writes).

## Development

```bash
# Type-check
npm run check
```

## License

MIT
