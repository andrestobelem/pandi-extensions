/**
 * Plan-flag resolution + parsing (the "pasar con parámetros o setear" surface).
 *
 * Extracted verbatim from index.ts to isolate the posture-flag precedence
 * (param -> session toggle -> env -> default) and the small parsers from the
 * command/state wiring. Depth-one sibling module imported by index.ts via
 * "./flags.js".
 *
 * `sessionFlagDefaults` is module-mutable state. Its ES-singleton identity lives
 * HERE (one object, mutated only through the functions below + the accessor/setter).
 * index.ts must NOT re-declare it — it reads/writes through getSessionFlagDefault /
 * setSessionFlagDefault.
 */

import { type PlanFlags } from "./prompts.js";

/** Keys of the session-default ultracode posture toggles. */
type SessionFlagKey = "ultracode" | "ultracodeSteps";

/** A setting is ON when the env var is one of the truthy tokens (1/true/on/yes). */
export function envFlag(name: string): boolean {
	const value = (process.env[name] ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * Session-level defaults for the ultracode posture, set by `/plan ultracode on|off` and
 * `/plan steps-ultracode on|off`. They sit BETWEEN an explicit param and the env setting
 * (param -> session toggle -> env -> default) and are reset at every session boundary.
 * nonInteractive is intentionally NOT a session toggle: it only matters in print/json, where
 * the session is one-shot, so it is set per call via param/env.
 */
const sessionFlagDefaults: { ultracode?: boolean; ultracodeSteps?: boolean } = {};

export function resetSessionFlagDefaults(): void {
	sessionFlagDefaults.ultracode = undefined;
	sessionFlagDefaults.ultracodeSteps = undefined;
}

/** Read a session-default toggle (undefined = unset, env/param decides). */
export function getSessionFlagDefault(key: SessionFlagKey): boolean | undefined {
	return sessionFlagDefaults[key];
}

/** Set a session-default toggle (true/false). */
export function setSessionFlagDefault(key: SessionFlagKey, value: boolean): void {
	sessionFlagDefaults[key] = value;
}

/**
 * Resolve the posture flags with precedence: explicit param -> session toggle -> environment
 * setting -> default (false). This is the "pasar con parámetros o setear" surface: tool/command
 * params win, then `/plan ultracode|steps-ultracode on|off` session defaults, then the PI_PLAN_*
 * env vars, else off. (nonInteractive skips the session-toggle layer.)
 */
export function resolvePlanFlags(params: PlanFlags): Required<PlanFlags> {
	return {
		nonInteractive: params.nonInteractive ?? envFlag("PI_PLAN_NONINTERACTIVE"),
		ultracode: params.ultracode ?? sessionFlagDefaults.ultracode ?? envFlag("PI_PLAN_ULTRACODE"),
		ultracodeSteps:
			params.ultracodeSteps ?? sessionFlagDefaults.ultracodeSteps ?? envFlag("PI_PLAN_ULTRACODE_STEPS"),
	};
}

/** Parse an on|off|status toggle argument (with common aliases). */
export function parsePlanToggleValue(raw: string): "on" | "off" | "status" | "invalid" {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
	return "invalid";
}

/**
 * Parse trailing `--ultracode` / `--ultracode-steps` (aliases `--uc` / `--uc-steps`) flags
 * off the /plan argument string. The remaining text is the <task>. The command path is
 * interactive-only, so it does NOT accept --non-interactive (there is no clean way to
 * deliver the planning instruction in print/json from a command; non-interactive entry is
 * the enter_plan_mode tool's job). Returns the cleaned task plus the parsed command flags.
 */
export function parsePlanCommandFlags(args: string): { task: string; flags: PlanFlags } {
	const flags: PlanFlags = {};
	const kept: string[] = [];
	for (const token of args.split(/\s+/)) {
		const lower = token.toLowerCase();
		if (lower === "--ultracode" || lower === "--uc") flags.ultracode = true;
		else if (lower === "--ultracode-steps" || lower === "--uc-steps") flags.ultracodeSteps = true;
		else if (token.length) kept.push(token);
	}
	return { task: kept.join(" "), flags };
}
