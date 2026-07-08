/**
 * Parser puro para la intención del comando `/plan`.
 *
 * El runtime (`index.ts`) ejecuta efectos: notificar, abrir dashboard, mutar estado,
 * armar/levantar el gate. Este módulo solo modela la gramática de entrada: comandos
 * de control exactos, toggles de postura y, en cualquier otro caso, una task libre.
 */

import { parsePlanToggleValue } from "./flags.js";

export type PlanToggleKey = "ultracode" | "ultracodeSteps" | "autoSubmit";
export type PlanToggleLabel = "ultracode" | "steps-ultracode" | "auto-submit";
export type PlanToggleAction = "on" | "off" | "status";

type PlanToggleMetadata = { key: PlanToggleKey; label: PlanToggleLabel };
type ParsedFirstToken = {
	firstSpace: number;
	firstToken: string;
	rest: string;
};

const PLAN_TOGGLE_METADATA = {
	ultracode: { key: "ultracode", label: "ultracode" },
	"steps-ultracode": { key: "ultracodeSteps", label: "steps-ultracode" },
	"auto-submit": { key: "autoSubmit", label: "auto-submit" },
} satisfies Record<string, PlanToggleMetadata>;

function parseFirstToken(input: string): ParsedFirstToken {
	const firstSpace = input.indexOf(" ");
	return {
		firstSpace,
		firstToken: (firstSpace === -1 ? input : input.slice(0, firstSpace)).toLowerCase(),
		rest: firstSpace === -1 ? "" : input.slice(firstSpace + 1),
	};
}

function getPlanToggleMetadata(token: string): PlanToggleMetadata | undefined {
	return PLAN_TOGGLE_METADATA[token as keyof typeof PLAN_TOGGLE_METADATA];
}

export type PlanCommandIntent =
	| { kind: "status" }
	| { kind: "dashboard" }
	| { kind: "exit"; command: "exit" | "cancel"; reason: string }
	| { kind: "toggle"; key: PlanToggleKey; label: PlanToggleLabel; action: PlanToggleAction }
	| { kind: "invalid-toggle"; label: PlanToggleLabel }
	| { kind: "start"; task: string };

/**
 * Parsea el string de argumentos de `/plan` sin ejecutar efectos.
 *
 * Reglas preservadas desde `handlePlanCommand`:
 * - `status`, `dashboard`/`tui`, `exit`/`cancel` solo son comandos si son el
 *   primer token completo y ÚNICO; con texto extra pasan a ser task.
 * - `ultracode`, `steps-ultracode` y `auto-submit` siempre son toggles cuando son primer token;
 *   un valor inválido no cae a task.
 * - las flags `--ultracode` / `--uc` se dejan dentro de `task` para que
 *   `startPlan` siga delegando su parsing a `parsePlanCommandFlags`.
 */
export function parsePlanCommandIntent(args: string): PlanCommandIntent {
	const trimmed = args.trim();
	const { firstSpace, firstToken, rest } = parseFirstToken(trimmed);

	if (firstSpace === -1 && firstToken === "status") return { kind: "status" };
	if (firstSpace === -1 && (firstToken === "dashboard" || firstToken === "tui")) return { kind: "dashboard" };

	const toggle = getPlanToggleMetadata(firstToken);
	if (toggle) {
		const action = parsePlanToggleValue(rest);
		if (action === "invalid") return { kind: "invalid-toggle", label: toggle.label };
		return { kind: "toggle", key: toggle.key, label: toggle.label, action };
	}

	if (firstSpace === -1 && (firstToken === "exit" || firstToken === "cancel")) {
		return { kind: "exit", command: firstToken, reason: `${firstToken} por el usuario` };
	}

	return { kind: "start", task: trimmed };
}
