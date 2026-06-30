// Read-only bash safety gate for prepare mode.
// Evaluates the finished command string directly — no full shell tokenizer.

const SAFE_COMMANDS = new Set([
  "awk", "bat", "cal", "cat", "cd", "curl", "date", "df", "diff", "du",
  "echo", "eza", "false", "fd", "file", "find", "git", "grep", "head",
  "id", "jq", "less", "ls", "more", "node", "npm", "pnpm", "printenv",
  "printf", "pwd", "python", "python3", "rg", "sed", "sort", "stat",
  "tail", "test", "tree", "true", "type", "uname", "uniq", "wc",
  "wget", "which", "whoami", "yarn",
]);

const COMMAND_INTRO_KEYWORDS = new Set(["then", "do", "elif", "else"]);

const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add", "am", "apply", "bisect", "branch", "checkout", "cherry-pick",
  "clean", "clone", "commit", "fetch", "init", "merge", "mv", "pull",
  "push", "rebase", "remote", "reset", "restore", "revert", "rm",
  "stash", "submodule", "switch", "tag", "worktree",
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "blame", "branch", "config", "describe", "diff", "grep", "log",
  "ls-files", "ls-tree", "rev-list", "rev-parse", "show", "status",
]);

const MUTATING_PACKAGE_SUBCOMMANDS = new Set([
  "add", "ci", "dedupe", "deploy", "exec", "init", "install", "i",
  "link", "login", "logout", "pack", "patch", "publish", "rebuild",
  "remove", "rm", "run", "set", "test", "uninstall", "unlink",
  "update", "upgrade",
]);
const SAFE_PACKAGE_SUBCOMMANDS = new Set([
  "audit", "explain", "info", "list", "ls", "outdated", "query",
  "search", "view", "why",
]);

export interface BashSafetyResult {
  safe: boolean;
  reason?: string;
}

function hasUnquotedCommandSubstitution(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "`" || (ch === "$" && next === "(")) return true;
    if (ch === "\\") i++;
  }
  return false;
}

function hasOutputRedirection(command: string): { blocked: boolean } {
  // Simple scan for > or >> outside quotes (but not >&1 / >&2 / /dev/null)
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === ">") {
      const rest = command.slice(i);
      // fd swap: >&1, >&2
      if (/^>&[12-9]/.test(rest)) { i += 2; continue; }
      // /dev/null target
      if (/^>>?\s*\/dev\/null/.test(rest)) continue;
      return { blocked: true };
    }
  }
  return { blocked: false };
}

/** Split a command into segments on statement separators. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      if (ch === "\\" && quote === '"') { current += next; i++; continue; }
      if (ch === quote) { quote = undefined; }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "\\") { current += next; i++; continue; }

    // Statement separators
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Extract the first actual command word from a segment. */
function firstCommandWord(segment: string): string | undefined {
  const words = segment.split(/\s+/).filter(Boolean);
  for (const word of words) {
    if (COMMAND_INTRO_KEYWORDS.has(word.toLowerCase())) continue;
    // skip variable assignments
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word;
  }
  return undefined;
}

/** Get non-option args after the first command word. */
function argsAfterCommand(segment: string): string[] {
  const cmd = firstCommandWord(segment);
  if (!cmd) return [];
  const words = segment.split(/\s+/).filter(Boolean);
  const idx = words.indexOf(cmd);
  return idx >= 0 ? words.slice(idx + 1) : [];
}

function firstNonOptionArg(args: string[]): string | undefined {
  return args.find((arg) => arg !== "--" && !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
}

function checkGit(segment: string): BashSafetyResult {
  const args = argsAfterCommand(segment);
  const sub = firstNonOptionArg(args);
  if (!sub) return { safe: true };
  const lower = sub.toLowerCase();

  if (lower === "branch") {
    if (args.some((arg) => /^-[^-]*[dDmM]/.test(arg) || arg === "--delete" || arg === "--move" || arg === "--copy")) {
      return { safe: false, reason: "git branch mutation is not allowed" };
    }
    return { safe: true };
  }
  if (lower === "config") {
    if (!args.some((arg) => arg === "--get" || arg === "--list" || arg === "-l" || arg === "--get-regexp")) {
      return { safe: false, reason: "git config is only allowed for read operations" };
    }
    return { safe: true };
  }
  if (MUTATING_GIT_SUBCOMMANDS.has(lower) && !SAFE_GIT_SUBCOMMANDS.has(lower)) {
    return { safe: false, reason: `git ${lower} is not allowed in prepare mode` };
  }
  if (!SAFE_GIT_SUBCOMMANDS.has(lower)) {
    return { safe: false, reason: `git ${lower} is not in the read-only allowlist` };
  }
  return { safe: true };
}

function checkPackageManager(command: string, segment: string): BashSafetyResult {
  const args = argsAfterCommand(segment);
  const sub = firstNonOptionArg(args);
  if (!sub) return { safe: true };
  const lower = sub.toLowerCase();
  if (MUTATING_PACKAGE_SUBCOMMANDS.has(lower)) {
    return { safe: false, reason: `${command} ${lower} is not allowed in prepare mode` };
  }
  if (!SAFE_PACKAGE_SUBCOMMANDS.has(lower)) {
    return { safe: false, reason: `${command} ${lower} is not in the read-only allowlist` };
  }
  return { safe: true };
}

function checkSedAwk(command: string, segment: string): BashSafetyResult {
  const args = argsAfterCommand(segment);
  if (args.some((arg) => arg === "-i" || arg === "--in-place")) {
    return { safe: false, reason: `${command} in-place editing is not allowed` };
  }
  if (command === "sed" && args.some((arg) => /^-.*i$/.test(arg))) {
    return { safe: false, reason: `${command} in-place editing is not allowed` };
  }
  return { safe: true };
}

function checkFind(segment: string): BashSafetyResult {
  const args = argsAfterCommand(segment).map((a) => a.toLowerCase());
  if (args.includes("-delete") || args.includes("-exec") || args.includes("-okdir")) {
    return { safe: false, reason: "find execution/deletion actions are not allowed" };
  }
  return { safe: true };
}

function checkCurlWget(command: string, segment: string): BashSafetyResult {
  const args = argsAfterCommand(segment);
  if (command === "curl") {
    const mutating = args.some((arg, i) => {
      const lower = arg.toLowerCase();
      return (
        lower === "-o" || lower === "--output" || lower === "-O" || lower === "--remote-name" ||
        lower === "-d" || lower === "--data" || lower.startsWith("--data-") ||
        ((lower === "-x" || lower === "--request") && /^(post|put|patch|delete)$/i.test(args[i + 1] ?? ""))
      );
    });
    if (mutating) return { safe: false, reason: "curl writes or mutating HTTP methods are not allowed" };
  }
  if (command === "wget") {
    const mutating = args.some((arg) =>
      arg === "-O" || arg === "--output-document" || arg === "-P" || arg === "--directory-prefix" ||
      arg === "--post-data" || arg === "--post-file"
    );
    if (mutating) return { safe: false, reason: "wget writes or mutating HTTP methods are not allowed" };
  }
  return { safe: true };
}

export function checkBashSafety(command: string): BashSafetyResult {
  if (!command.trim()) return { safe: false, reason: "empty bash command" };

  // Reject unquoted command substitution
  if (hasUnquotedCommandSubstitution(command)) {
    return { safe: false, reason: "command substitution is not allowed in prepare mode" };
  }

  // Reject output redirection to real files
  if (hasOutputRedirection(command).blocked) {
    return { safe: false, reason: "output redirection to files is not allowed" };
  }

  // Check each segment
  for (const segment of splitSegments(command)) {
    const raw = firstCommandWord(segment);
    if (!raw) continue;
    const cmd = raw.toLowerCase();

    if (!SAFE_COMMANDS.has(cmd)) {
      return { safe: false, reason: `${cmd} is not in the read-only allowlist` };
    }

    let result: BashSafetyResult = { safe: true };
    switch (cmd) {
      case "git":
        result = checkGit(segment);
        break;
      case "npm":
      case "pnpm":
      case "yarn":
        result = checkPackageManager(cmd, segment);
        break;
      case "sed":
      case "awk":
        result = checkSedAwk(cmd, segment);
        break;
      case "find":
      case "fd":
        result = checkFind(segment);
        break;
      case "curl":
      case "wget":
        result = checkCurlWget(cmd, segment);
        break;
    }
    if (!result.safe) return result;
  }

  return { safe: true };
}

