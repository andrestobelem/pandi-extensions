/**
 * Worktree copy-default resolution + parsing (the "pass-per-call OR set" surface).
 *
 * Mirrors pi-plan's flags.ts pattern, kept SELF-CONTAINED in this extension
 * (intentional per-extension duplication — NOT a cross-extension `../shared/`
 * import — so the extension keeps working when installed standalone).
 *
 * `--copy-ignored` / `--copy-untracked` (and the tool's copyIgnored/copyUntracked
 * params) already let a caller turn copying ON per call. This adds the missing
 * "setear" surface: a session default (`/worktree set copy-ignored on|off`) and
 * an environment default, plus the ability to turn copying OFF per call
 * (`--no-copy-ignored`) to override an ON default.
 *
 * Precedence (highest first): explicit per-call param (true/false) -> session
 * default -> environment (PI_WORKTREE_COPY_*) -> false.
 *
 * `sessionCopyDefaults` is module-mutable state. Its ES-singleton identity lives
 * HERE (one object, mutated only through the functions below). index.ts must NOT
 * re-declare it — it reads/writes through get/set/resetSessionCopyDefault(s).
 * Depth-one sibling module imported by index.ts/command.ts via "./copy-prefs.js".
 */

/** A setting is ON when the env var is one of the truthy tokens (1/true/on/yes). */
export function envFlag(name: string): boolean {
	const value = (process.env[name] ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "on" || value === "yes";
}

/** Tri-state copy preferences: undefined = "not specified, fall through". */
export interface CopyPrefs {
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

/** Keys of the session-default copy toggles. */
export type CopyPrefKey = "copyIgnored" | "copyUntracked";

/**
 * Session-level defaults set by `/worktree set copy-ignored|copy-untracked on|off`.
 * They sit BETWEEN an explicit per-call param and the env setting and are reset at
 * every session boundary (see index.ts session_start hook).
 */
const sessionCopyDefaults: CopyPrefs = {};

export function resetSessionCopyDefaults(): void {
	sessionCopyDefaults.copyIgnored = undefined;
	sessionCopyDefaults.copyUntracked = undefined;
}

/** Read a session-default toggle (undefined = unset, env/param decides). */
export function getSessionCopyDefault(key: CopyPrefKey): boolean | undefined {
	return sessionCopyDefaults[key];
}

/** Set a session-default toggle (true/false). */
export function setSessionCopyDefault(key: CopyPrefKey, value: boolean): void {
	sessionCopyDefaults[key] = value;
}

/**
 * Resolve copy preferences with precedence: explicit per-call param (true/false)
 * -> session default -> environment (PI_WORKTREE_COPY_*) -> false. Returns
 * concrete booleans so callers and the copy note never see undefined.
 */
export function resolveCopyPrefs(params: CopyPrefs): { copyIgnored: boolean; copyUntracked: boolean } {
	return {
		copyIgnored: params.copyIgnored ?? sessionCopyDefaults.copyIgnored ?? envFlag("PI_WORKTREE_COPY_IGNORED"),
		copyUntracked: params.copyUntracked ?? sessionCopyDefaults.copyUntracked ?? envFlag("PI_WORKTREE_COPY_UNTRACKED"),
	};
}

/** Parse an on|off|status toggle argument (with common aliases). */
export function parseCopyToggleValue(raw: string): "on" | "off" | "status" | "invalid" {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
	return "invalid";
}
