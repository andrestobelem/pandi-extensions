/**
 * Resolución de banderas de plan + parsing (la superficie "pasar con parámetros o setear").
 *
 * Extraído verbatim de index.ts para aislar la precedencia de postura-bandera
 * (param -> session toggle -> env -> default) y los pequeños parsers del
 * cableado de comando/state. Módulo sibling de profundidad uno importado por index.ts vía
 * "./flags.js".
 *
 * `sessionFlagDefaults` es estado mutable de módulo. Su identidad ES-singleton vive
 * AQUÍ (un objeto, mutado solo a través de las funciones abajo + el accessor/setter).
 * index.ts NO DEBE re-declararlo — lee/escribe a través de getSessionFlagDefault /
 * setSessionFlagDefault.
 */

import type { PlanFlags } from "./posture.js";

/** Claves de los toggles de postura por defecto de sesión. */
type SessionFlagKey = "ultracode" | "ultracodeSteps" | "autoSubmit";

/** Un setting está ON cuando la env var es uno de los tokens truthy (1/true/on/yes). */
export function envFlag(name: string): boolean {
	const value = (process.env[name] ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * Defaults a nivel sesión para la postura, seteados por `/plan ultracode on|off`,
 * `/plan steps-ultracode on|off` y `/plan auto-submit on|off`. Están ENTRE un param
 * explícito y el setting env (param -> session toggle -> env -> default) y se resetean en cada frontera de sesión.
 * nonInteractive NO es intencionalmente un toggle de sesión: solo importa en print/json, donde
 * la sesión es one-shot, así que se setea por llamada vía param/env.
 */
const sessionFlagDefaults: { ultracode?: boolean; ultracodeSteps?: boolean; autoSubmit?: boolean } = {};

export function resetSessionFlagDefaults(): void {
	sessionFlagDefaults.ultracode = undefined;
	sessionFlagDefaults.ultracodeSteps = undefined;
	sessionFlagDefaults.autoSubmit = undefined;
}

/** Lee un toggle de defecto de sesión (undefined = unset, env/param decide). */
export function getSessionFlagDefault(key: SessionFlagKey): boolean | undefined {
	return sessionFlagDefaults[key];
}

/** Setea un toggle de defecto de sesión (true/false). */
export function setSessionFlagDefault(key: SessionFlagKey, value: boolean): void {
	sessionFlagDefaults[key] = value;
}

/**
 * Resuelve las banderas de postura con precedencia: param explícito -> session toggle -> env
 * setting -> default (false). Esta es la superficie "pasar con parámetros o setear": params de command
 * ganan, luego defaults de sesión `/plan ultracode|steps-ultracode|auto-submit on|off`, luego las
 * env vars PI_PLAN_*, sino off. (nonInteractive salta la capa session-toggle.)
 */
export function resolvePlanFlags(params: PlanFlags): Required<PlanFlags> {
	return {
		nonInteractive: params.nonInteractive ?? envFlag("PI_PLAN_NONINTERACTIVE"),
		ultracode: params.ultracode ?? sessionFlagDefaults.ultracode ?? envFlag("PI_PLAN_ULTRACODE"),
		ultracodeSteps: params.ultracodeSteps ?? sessionFlagDefaults.ultracodeSteps ?? envFlag("PI_PLAN_ULTRACODE_STEPS"),
		autoSubmit: params.autoSubmit ?? sessionFlagDefaults.autoSubmit ?? envFlag("PI_PLAN_AUTO_SUBMIT"),
	};
}

/** Parsea un argumento toggle on|off|status (con alias comunes). */
export function parsePlanToggleValue(raw: string): "on" | "off" | "status" | "invalid" {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
	return "invalid";
}

/**
 * Parsea flags `--ultracode` / `--ultracode-steps` / `--auto-submit` (aliases
 * `--uc` / `--uc-steps`) trailidores fuera del string de argumento /plan. El texto restante es el <task>. La ruta del comando es
 * solo interactiva, así que NO acepta --non-interactive (no hay forma limpia de
 * entregar la instrucción de planificación en print/json desde un comando; la entrada no interactiva es
 * trabajo de la tool enter_plan_mode). Devuelve la tarea limpia más las banderas del comando parseadas.
 */
export function parsePlanCommandFlags(args: string): { task: string; flags: PlanFlags } {
	const flags: PlanFlags = {};
	const kept: string[] = [];
	for (const token of args.split(/\s+/)) {
		const lower = token.toLowerCase();
		if (lower === "--ultracode" || lower === "--uc") flags.ultracode = true;
		else if (lower === "--ultracode-steps" || lower === "--uc-steps") flags.ultracodeSteps = true;
		else if (lower === "--auto-submit") flags.autoSubmit = true;
		else if (token.length) kept.push(token);
	}
	return { task: kept.join(" "), flags };
}
