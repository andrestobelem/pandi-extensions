/**
 * Recuperación durable y mantenimiento de sidecars para `/loop`.
 *
 * `index.ts` conserva el Map vivo como fuente de verdad y lo inyecta acá para
 * evitar que este módulo posea estado de proceso o forme ciclos con lifecycle/scheduler.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capExceeded } from "./caps.js";
import { GC_MAX_AGE_MS, LOOP_STATE_TYPE, STATE_FILE, WATCHDOG_HARD_DEADLINE_MS } from "./constants.js";
import { stopLoop } from "./lifecycle.js";
import { notify } from "./notify.js";
import {
	currentOwnerSessionId,
	discoverSidecarLoopIds,
	loopStateRoot,
	newerState,
	readSidecarSnapshot,
} from "./persistence.js";
import { fireWake, stopByWatchdog, stopForCap } from "./scheduler.js";
import { collectLatestByKey } from "./session-state.js";
import {
	type ActiveLoop,
	fromSnapshot,
	isValidLoopId,
	type LoopState,
	type LoopStatus,
	type ParsedLoopStateSnapshot,
	parseLoopStateSnapshot,
	shouldRehydrateLoopForSession,
} from "./state.js";
import { refreshLoopStatus } from "./status.js";

export type RecoveryDeps = {
	getActiveLoops: () => Map<string, ActiveLoop>;
};

let recoveryDeps: RecoveryDeps;

/** Registra el estado vivo que permanece bajo propiedad de index.ts. */
export function configureRecovery(deps: RecoveryDeps): void {
	recoveryDeps = deps;
}

function reportIgnoredJsonlState(ctx: ExtensionContext): void {
	try {
		notify(ctx, "Snapshot loop-state ignorado: loopId inválido", "warning");
	} catch {
		// La observabilidad best-effort no puede bloquear la recuperación segura.
	}
}

function newerSnapshot(
	a: ParsedLoopStateSnapshot | undefined,
	b: ParsedLoopStateSnapshot | undefined,
): ParsedLoopStateSnapshot | undefined {
	const winner = newerState(a?.state, b?.state);
	return winner === b?.state ? b : a;
}

/**
 * Reconstruye estado de loop y rearma. La fuente de verdad por loopId es el MÁS NUEVO
 * entre la última entrada JSONL y el sidecar atómico (por updatedAt), cubriendo un crash
 * duro donde el JSONL podría perder el último append. Evita double-fire: si activeLoops
 * ya tiene el loop (timer vivo en este proceso), saltea. Solo un catch-up tick: sin burst.
 * Recupera loops "paused" como paused (sin rearmar). Respeta caps (nunca rearma pasado uno).
 */
export async function rehydrate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const activeLoops = recoveryDeps.getActiveLoops();
	const entries = ctx.sessionManager.getEntries();
	const latestJsonlRaw = collectLatestByKey<Record<string, unknown>>(entries, LOOP_STATE_TYPE, (data) => data.loopId);
	const latestJsonl = new Map<string, ParsedLoopStateSnapshot>();
	for (const [loopId, raw] of latestJsonlRaw) {
		if (!isValidLoopId(loopId)) {
			reportIgnoredJsonlState(ctx);
			continue;
		}
		const parsed = parseLoopStateSnapshot(raw);
		if (parsed) latestJsonl.set(loopId, parsed);
	}

	// Resolver cada loopId contra su sidecar (gana el más nuevo por updatedAt). Incluir
	// también loopIds sidecar-only: el sidecar es específicamente el fallback de crash recovery
	// para una transición que llegó a state.json pero no al JSONL de sesión.
	const resolved = new Map<string, ParsedLoopStateSnapshot>();
	const sidecarLoopIds = await discoverSidecarLoopIds(ctx);
	const ownerSessionId = currentOwnerSessionId(ctx);
	for (const loopId of new Set([...latestJsonl.keys(), ...sidecarLoopIds])) {
		const jsonlState = latestJsonl.get(loopId);
		const sidecar = await readSidecarSnapshot(ctx, loopId);
		const winner = newerSnapshot(jsonlState, sidecar);
		if (winner && shouldRehydrateLoopForSession(winner.state, ownerSessionId, latestJsonl.has(loopId))) {
			resolved.set(loopId, winner);
		}
	}

	for (const parsed of resolved.values()) {
		const { state } = parsed;
		// "running" = estaba vivo en un proceso previo; "stale" = persistido por un
		// session_shutdown limpio (reload/quit); "paused" = recuperar y mantener paused.
		// Todo lo demás (stopped/done/failed) es terminal → saltear.
		if (state.status !== "running" && state.status !== "stale" && state.status !== "paused") continue;
		// Timer todavía vivo en este proceso → no rearmar (sin double-fire).
		if (activeLoops.has(state.loopId)) continue;
		if (parsed.invalidScheduleReason) {
			const retired = fromSnapshot(state, "stopped");
			activeLoops.set(retired.loopId, retired);
			stopLoop(pi, ctx, retired.loopId, `snapshot retirado: ${parsed.invalidScheduleReason}`, "stopped");
			continue;
		}
		// Revalidar trust en cada re-entry: un objetivo autónomo no debe sobrevivir si el
		// proyecto perdió confianza desde la confirmación original.
		if (state.autonomous && !ctx.isProjectTrusted()) {
			const retired = fromSnapshot(state, "stopped");
			activeLoops.set(retired.loopId, retired);
			stopLoop(pi, ctx, retired.loopId, "loop autónomo retirado: el proyecto ya no es de confianza", "stopped");
			continue;
		}

		const recoverPaused = state.status === "paused";
		const loop = fromSnapshot(state, recoverPaused ? "paused" : "running");
		activeLoops.set(loop.loopId, loop);

		// Los loops paused se recuperan idle (sin timer) hasta /loop resume.
		if (recoverPaused) continue;

		// Un cap ya excedido durante el downtime → detener limpiamente en vez de rearmar.
		const cap = capExceeded(ctx, loop);
		if (cap) {
			stopForCap(pi, ctx, loop, cap);
			continue;
		}

		const remaining = loop.nextFireAt === null ? 0 : Math.max(0, loop.nextFireAt - Date.now());
		// Un único tick de catch-up (clampeado a >= 0); nunca un burst de wakes perdidos.
		loop.timer = setTimeout(() => fireWake(pi, ctx, loop), remaining);
	}
	refreshLoopStatus(ctx, activeLoops.values());
	// Barrido final: no rearmar loops que ya son zombies tras el downtime.
	watchdogSweep(pi, ctx);
}

const TERMINAL_STATUSES: ReadonlySet<LoopStatus> = new Set<LoopStatus>(["done", "stopped", "failed"]);

/**
 * Borra sidecars viejos solo si el snapshot es terminal y su `updatedAt` supera
 * GC_MAX_AGE_MS. Los loops vivos o presentes en memoria se preservan siempre.
 */
export async function gcOldTerminalLoops(ctx: ExtensionContext, now: number = Date.now()): Promise<number> {
	const activeLoops = recoveryDeps.getActiveLoops();
	const root = loopStateRoot(ctx);
	if (!existsSync(root)) return 0;
	let removed = 0;
	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const dirent of dirents) {
		if (!dirent.isDirectory()) continue;
		const loopId = dirent.name;
		if (!isValidLoopId(loopId)) continue;
		// Un loop vivo en este proceso puede tener timer armado.
		if (activeLoops.has(loopId)) continue;
		const dir = path.join(root, loopId);
		const file = path.join(dir, STATE_FILE);
		try {
			const body = await fs.readFile(file, "utf8");
			const state = JSON.parse(body) as LoopState;
			if (!state || typeof state.status !== "string") continue;
			// Los estados vivos se preservan indefinidamente.
			if (!TERMINAL_STATUSES.has(state.status)) continue;
			const updated = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
			// Sin fecha confiable no hay borrado.
			if (!Number.isFinite(updated) || now - updated < GC_MAX_AGE_MS) continue;
			await fs.rm(dir, { recursive: true, force: true });
			removed += 1;
		} catch {
			// GC es best-effort: estado corrupto o fallo de rm no debe romper la sesión.
		}
	}
	return removed;
}

/**
 * Último respaldo contra loops running colgados más allá del deadline duro. Paused no
 * es zombie: no tiene timer armado y espera una reanudación explícita del usuario.
 *
 * No hay timer dedicado; los pulsos naturales (session_start, agent_end, fireWake)
 * bastan, y un proceso muerto solo puede recuperarse en el siguiente session_start.
 */
export function watchdogSweep(pi: ExtensionAPI, ctx: ExtensionContext, now: number = Date.now()): number {
	let killed = 0;
	for (const loop of [...recoveryDeps.getActiveLoops().values()]) {
		// Solo running puede ser zombie; paused está idle a propósito.
		if (loop.status !== "running") continue;
		if (now - loop.startedAt < WATCHDOG_HARD_DEADLINE_MS) continue;
		stopByWatchdog(pi, ctx, loop);
		killed += 1;
	}
	return killed;
}
