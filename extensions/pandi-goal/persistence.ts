/**
 * Helpers de persistencia para la extensión `/goal`, extraídos a un hermano para que
 * index.ts conserve solo el engine/wiring. Están PARAMETRIZADOS (reciben
 * pi/ctx/goal/state como argumentos) y no cierran sobre estado mutable del módulo, así que
 * se mueven limpiamente. El comportamiento no cambia: mismo append JSONL vía
 * pi.appendEntry + escritura sidecar atómica (archivo temporal y luego rename), misma
 * semántica de tragar errores.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { GOAL_DIR, GOAL_STATE_TYPE, PROGRESS_LOG_KEEP, STATE_FILE } from "./constants.js";
import type { ActiveGoal, GoalState } from "./types.js";

export function snapshot(goal: ActiveGoal): GoalState {
	const {
		timer: _timer,
		controller: _controller,
		rearmedThisTurn: _rearmedThisTurn,
		verifierInFlight: _verifierInFlight,
		...state
	} = goal;
	return {
		...state,
		// Acotar el log persistido para que la entrada JSONL nunca crezca sin límite.
		assessments: state.assessments.slice(-PROGRESS_LOG_KEEP),
	};
}

/**
 * Persiste una transición del goal. Sella `updatedAt`, agrega al JSONL de sesión (NO va
 * al LLM) y dispara sin esperar una escritura sidecar ATÓMICA para recovery ante crashes.
 */
export function persist(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.updatedAt = new Date().toISOString();
	const snap = snapshot(goal);
	pi.appendEntry<GoalState>(GOAL_STATE_TYPE, snap);
	void writeSidecar(ctx, snap).catch(() => {});
}

/**
 * Dir de estado con doble raíz:
 * - proyecto confiable → <cwd>/.pi/goals/<id>
 * - en otro caso       → <agentDir>/goals/<projectHash>/<id>
 */
function goalStateDir(ctx: ExtensionContext, goalId: string): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, GOAL_DIR, goalId);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), GOAL_DIR, projectHash, goalId);
}

/** Escritura atómica: archivo temporal y luego rename, así un crash a mitad de escritura nunca trunca state.json. */
async function writeSidecar(ctx: ExtensionContext, state: GoalState): Promise<void> {
	const dir = goalStateDir(ctx, state.goalId);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, STATE_FILE);
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}
