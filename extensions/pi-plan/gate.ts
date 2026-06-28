/**
 * The read-only GATE for plan mode — the PURE policy of exactly what a tool call
 * is allowed to do while a plan is being drafted.
 *
 * Extracted verbatim from index.ts (behavior-preserving). Pure and side-effect
 * free, so it is trivially testable and reviewable in isolation (the safety
 * guarantee lives here; the wiring/handleToolCall stays in index.ts).
 *
 * Depth-one sibling module (matches the `package.json` `files` glob); imported
 * by index.ts via "./gate.js", so it is typechecked transitively. The
 * `ToolCallEvent` import is type-only and erased at build time.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Allowlist of MUTATING bash commands (best-effort, documented). The gate blocks a bash
 * call IFF its command matches one of these; everything else (reads) is allowed. This is
 * the inverse use of loop.ts's DESTRUCTIVE_BASH_PATTERNS machinery (flag-order-independent
 * look-aheads), broadened per the brief. It is BEST-EFFORT: a sufficiently creative shell
 * command can evade it (e.g. obscure tooling, an aliased mutator). The hard guarantees are
 * on the structured tools (write/edit/notebook-edit are ALWAYS blocked); bash is a
 * heuristic backstop. When unsure we err toward BLOCKING (this is plan mode — no mutation).
 *
 * Blocking set:
 *   - File creation / deletion / move / metadata changes: touch, mkdir, rm, rmdir, mv, truncate, shred, unlink, chmod, chown, chgrp
 *   - In-place / writing tooling: sed -i, tee, dd, mkfs
 *   - Shell redirections that WRITE a file: >, >>, >|, including numbered-fd
 *     writes like 2>err.log (but NOT fd duplications like 2>&1)
 *   - Git mutations: commit, add, push, reset, clean, checkout, switch, restore, merge,
 *     rebase, stash, apply, rm, mv, tag, branch -D/-d, cherry-pick, revert
 *   - Package installs: npm/pnpm/yarn install|add|ci, npx -y, pip/pipx install, poetry add,
 *     cargo add, go get, gem install, brew install, bun add/install
 *   - Infra/build that writes: make, kubectl apply/delete, terraform apply/destroy,
 *     helm upgrade/install/uninstall
 */
export const MUTATING_BASH_PATTERNS: RegExp[] = [
	// File creation / deletion / move / metadata changes (any flags). \brm\b also covers rm -rf.
	/\btouch\b/i,
	/\bmkdir\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bln\b/i,
	/\binstall\b/i, // GNU coreutils `install` creates files; also re-covers npm/pip install
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bunlink\b/i,
	// In-place / file-writing tooling.
	/\bsed\b[^\n]*\s-i\b/i, // sed -i (in-place edit)
	/\btee\b/i,
	/\bdd\b[^\n]*\b(if|of)=/i,
	/\bmkfs(\.\w+)?\b/i,
	// Shell redirections that write a file: >, >>, >|, including numbered-fd
	// writes like 2>err.log (avoid matching 2>&1 / >&N fd-dups, and the operators
	// ->, =>, >= which are not redirections).
	/(^|[^&>=-])>>?\s*(?![&>=])/,
	/>\|/,
	// Git mutations.
	/\bgit\b[^\n]*\b(commit|add|push|reset|clean|checkout|switch|restore|merge|rebase|stash|apply|rm|mv|tag|cherry-pick|revert)\b/i,
	/\bgit\b[^\n]*\bbranch\b[^\n]*\s-[dD]\b/i,
	// Package installs.
	/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|ci)\b/i,
	/\bnpx\b[^\n]*\s-y\b/i,
	/\b(pip|pip3|pipx)\b[^\n]*\binstall\b/i,
	/\bpoetry\b[^\n]*\badd\b/i,
	/\bcargo\b[^\n]*\badd\b/i,
	/\bgo\b[^\n]*\bget\b/i,
	/\bgem\b[^\n]*\binstall\b/i,
	/\bbrew\b[^\n]*\binstall\b/i,
	// Infra / build that writes.
	/\bmake\b/i,
	/\bkubectl\b[^\n]*\b(apply|delete)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall)\b/i,
];

/** Is this bash command a mutation per the best-effort allowlist? */
export function isMutatingBash(command: string): boolean {
	return MUTATING_BASH_PATTERNS.some((re) => re.test(command));
}

/**
 * Decide whether a tool call should be HARD-BLOCKED while plan mode is active. Returns a
 * human-readable reason when it should be blocked, else undefined (allow). Pure (no side
 * effects) so it is trivially testable.
 *
 * Always blocked (the built-in mutating tools): write, edit. (notebook-edit is also blocked
 *                                                defensively by name, though it is not a
 *                                                built-in in this SDK — see note below.)
 * Always allowed (read-only built-ins):          read, grep, find, ls, submit_plan.
 * bash:                                           blocked iff the command matches the
 *                                                mutating allowlist (above); else allowed.
 * Known mutating custom tools:                    dynamic_workflow is blocked unless its
 *                                                action is read-only (list/template/read/
 *                                                graph/runs/view). It can write files to the
 *                                                workspace and spawn subagents that run
 *                                                write/edit/bash, and those subagent tool
 *                                                calls do NOT pass through this main-session
 *                                                gate — so blocking it here is the only place
 *                                                we can stop it.
 * Any other tool name:                            allowed. The HARD guarantees are the built-in
 *                                                structured mutators (write/edit) + the bash
 *                                                heuristic + the known custom-tool block above;
 *                                                an unknown custom mutating tool registered by
 *                                                another extension/MCP would fall through here
 *                                                (best-effort — we rely on the prompt for those).
 */
export const DYNAMIC_WORKFLOW_READONLY_ACTIONS = new Set(["list", "template", "read", "graph", "runs", "view"]);

export function blockedReason(event: ToolCallEvent): string | undefined {
	const name = event.toolName;
	// submit_plan is the one permitted "output" (writing the plan).
	if (name === "submit_plan") return undefined;
	// Structured built-in mutators are ALWAYS blocked. notebook-edit is matched by string
	// compare (defensive — it is not a built-in tool name in this SDK, but blocking a
	// non-existent name is inert and future-proofs against a notebook editor being added).
	if (name === "write" || name === "edit" || name === "notebook-edit") {
		return `plan mode is READ-ONLY: the "${name}" tool is blocked while planning. Present your plan via submit_plan; you can edit after the user approves.`;
	}
	// Read-only built-ins are always allowed.
	if (name === "read" || name === "grep" || name === "find" || name === "ls") return undefined;
	// bash: block only mutating commands; allow read-only ones (cat, git ls-files, grep...).
	if (name === "bash") {
		const command = (event.input as { command?: unknown }).command;
		if (typeof command === "string" && isMutatingBash(command)) {
			return `plan mode is READ-ONLY: this shell command looks like a mutation and is blocked while planning: ${command.slice(0, 200)}`;
		}
		return undefined;
	}
	// Known mutating custom tool: dynamic_workflow can write files (action=write) and spawn
	// subagents with write/edit/bash (action=run/start/resume), whose tool calls bypass this
	// main-session gate entirely. Allow only its read-only actions; block the rest. If the
	// action is missing/unknown we err toward BLOCKING (this is plan mode — no mutation).
	if (name === "dynamic_workflow") {
		const action = (event.input as { action?: unknown }).action;
		if (typeof action === "string" && DYNAMIC_WORKFLOW_READONLY_ACTIONS.has(action)) return undefined;
		return `plan mode is READ-ONLY: dynamic_workflow "${String(action)}" can write files or spawn mutating subagents and is blocked while planning. Use only read-only actions (list/template/read/graph/runs/view), or submit_plan when your plan is ready.`;
	}
	// Unknown / other tools: allow. The hard guarantees above (built-in mutators + bash
	// heuristic + the known custom-tool block) are best-effort; an unknown custom mutating
	// tool would fall through here, in which case we rely on the planning prompt.
	return undefined;
}
