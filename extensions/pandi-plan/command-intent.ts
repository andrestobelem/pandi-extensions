/**
 * Parser puro para la intención del comando `/plan`.
 *
 * El runtime (`index.ts`) ejecuta efectos: notificar, abrir dashboard, mutar estado,
 * armar/levantar el gate. Este módulo solo modela la gramática de entrada: comandos
 * de control exactos, toggles de postura y, en cualquier otro caso, una task libre.
 */

import { parsePlanToggleValue } from "./flags.js";

export type PlanToggleKey = "ultracode" | "ultracodeSteps";
export type PlanToggleLabel = "ultracode" | "steps-ultracode";
export type PlanToggleAction = "on" | "off" | "status";

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
 * - `ultracode` y `steps-ultracode` siempre son toggles cuando son primer token;
 *   un valor inválido no cae a task.
 * - las flags `--ultracode` / `--uc` se dejan dentro de `task` para que
 *   `startPlan` siga delegando su parsing a `parsePlanCommandFlags`.
 */
export function parsePlanCommandIntent(args: string): PlanCommandIntent {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();

	if (firstSpace === -1 && firstToken === "status") return { kind: "status" };
	if (firstSpace === -1 && (firstToken === "dashboard" || firstToken === "tui")) return { kind: "dashboard" };

	if (firstToken === "ultracode" || firstToken === "steps-ultracode") {
		const key = firstToken === "ultracode" ? "ultracode" : "ultracodeSteps";
		const label = firstToken === "ultracode" ? "ultracode" : "steps-ultracode";
		const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
		const action = parsePlanToggleValue(rest);
		if (action === "invalid") return { kind: "invalid-toggle", label };
		return { kind: "toggle", key, label, action };
	}

	if (firstSpace === -1 && (firstToken === "exit" || firstToken === "cancel")) {
		return { kind: "exit", command: firstToken, reason: `${firstToken} por el usuario` };
	}

	return { kind: "start", task: trimmed };
}
