// ── Phase ────────────────────────────────────────────────
export type PreparePhase = "idle" | "preparing" | "executing";

// ── Plan ─────────────────────────────────────────────────
export interface PlanStep {
  id: string;          // stable identifier, e.g. "step-1"
  number: number;      // sequential step number starting from 1
  title: string;       // short title after the "—" in ### Step N — Title
  what?: string;       // description of the work
  files?: string[];    // exact file paths to create or modify
  details?: string;    // specific changes within those files
  acceptanceCriteria?: string; // concrete conditions proving completion
  dependencies?: string[];     // which prior steps must complete first
  completed: boolean;
}

export interface PreparedPlan {
  rawText: string;     // full prose text of the submitted plan
  steps: PlanStep[];   // parsed structured steps
}

// ── State ────────────────────────────────────────────────
export interface PrepareState {
  phase: PreparePhase;
  plan: PreparedPlan | null;
}

// ── Questionnaire ────────────────────────────────────────
export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
}

export interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

