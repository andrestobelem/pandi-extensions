/**
 * Helpers de persistencia para la extensión `/loop`, extraídos a un hermano para que
 * index.ts conserve solo el engine/wiring. Están PARAMETRIZADOS (reciben
 * pi/ctx/loop/state como argumentos) y no cierran sobre `activeLoops`, así que se
 * mueven limpiamente. Conservan el append JSONL vía pi.appendEntry y la escritura
 * sidecar atómica (archivo temporal y luego rename); las escrituras del mismo sidecar
 * se serializan y sus errores quedan observables sin propagarse al engine.
 *
 * `snapshot` vive en state.ts (modelo de dominio); acá solo se consume.
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
import { LOOP_DIR, LOOP_STATE_TYPE, STATE_FILE } from "./constants.js";
import { notify } from "./notify.js";
import {
	type ActiveLoop,
	isValidLoopId,
	type LoopState,
	type ParsedLoopStateSnapshot,
	parseLoopStateSnapshot,
	snapshot,
} from "./state.js";

const pendingSidecarWrites = new Map<string, Promise<void>>();
const TERMINAL_STATUSES: ReadonlySet<LoopState["status"]> = new Set(["done", "stopped", "failed"]);

/** Id de sesión dueña del proceso actual, si el sessionManager lo expone. */
export function currentOwnerSessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.trim() ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Persiste una transición de loop. Marca `updatedAt` (para resolver conflictos
 * JSONL vs sidecar por recencia), agrega al JSONL de sesión (NO va al LLM), y
 * dispara sin esperar una escritura sidecar ATOMIC que cubre un crash duro donde
 * el JSONL podría perder el último append.
 */
export function persist(pi: ExtensionAPI, ctx: ExtensionContext, loop: ActiveLoop): void {
	if (!isValidLoopId(loop.loopId)) {
		reportSidecarError(ctx, loop, new Error("loopId inválido: debe ser un único segmento portable"));
		return;
	}
	loop.updatedAt = new Date().toISOString();
	const snap = snapshot(loop);
	pi.appendEntry<LoopState>(LOOP_STATE_TYPE, snap);
	// Sidecar atómico best-effort (nunca lanza al engine).
	enqueueSidecarWrite(ctx, snap);
}

/** Root que guarda los sidecars del proyecto actual (trusted vs agentDir). */
export function loopStateRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, LOOP_DIR);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), LOOP_DIR, projectHash);
}

/**
 * Dir de estado dual-root, reflejando dynamic-workflows getRunRoot:
 * - proyecto trusted → <cwd>/.pi/loops/<id>
 * - si no            → <agentDir>/loops/<projectHash>/<id>
 */
export function loopStateDir(ctx: ExtensionContext, loopId: string): string {
	if (!isValidLoopId(loopId)) {
		throw new Error("loopId inválido: debe ser un único segmento portable");
	}
	return path.join(loopStateRoot(ctx), loopId);
}

/** Escritura atómica: temp file y rename, para que un crash a mitad de escritura no trunque state.json. */
async function writeSidecar(ctx: ExtensionContext, state: LoopState): Promise<void> {
	const dir = loopStateDir(ctx, state.loopId);
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

function reportSidecarError(ctx: ExtensionContext, state: LoopState, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	try {
		notify(ctx, `Loop ${state.loopId}: no se pudo persistir el sidecar: ${detail}`, "error");
	} catch {
		// La observabilidad no puede convertir un fallo best-effort en un unhandledRejection.
	}
}

function reportIgnoredState(ctx: ExtensionContext, message: string): void {
	try {
		notify(ctx, message, "warning");
	} catch {
		// Un warning best-effort no puede convertir estado inválido en un fallo de recovery.
	}
}

/** Mantiene orden lógico por archivo sin bloquear sidecars de otros loops. */
function enqueueSidecarWrite(ctx: ExtensionContext, state: LoopState): void {
	const file = path.join(loopStateDir(ctx, state.loopId), STATE_FILE);
	const previous = pendingSidecarWrites.get(file);
	const current = previous
		? previous.catch(() => {}).then(async () => writeSidecar(ctx, state))
		: writeSidecar(ctx, state);
	pendingSidecarWrites.set(file, current);

	void current.then(
		() => {
			if (pendingSidecarWrites.get(file) === current) pendingSidecarWrites.delete(file);
		},
		(error: unknown) => {
			if (pendingSidecarWrites.get(file) === current) pendingSidecarWrites.delete(file);
			reportSidecarError(ctx, state, error);
		},
	);
}

/** Lee y parsea la frontera schedule de un sidecar, preservando la razón de retiro si es inválido. */
export async function readSidecarSnapshot(
	ctx: ExtensionContext,
	loopId: string,
): Promise<ParsedLoopStateSnapshot | undefined> {
	if (!isValidLoopId(loopId)) {
		reportIgnoredState(ctx, "Sidecar ignorado: loopId inválido");
		return undefined;
	}
	try {
		const file = path.join(loopStateDir(ctx, loopId), STATE_FILE);
		const body = await fs.readFile(file, "utf8");
		const raw = JSON.parse(body) as unknown;
		if (
			raw &&
			typeof raw === "object" &&
			!Array.isArray(raw) &&
			"loopId" in raw &&
			(raw as { loopId?: unknown }).loopId !== loopId
		) {
			reportIgnoredState(
				ctx,
				`Sidecar ${loopId} ignorado: loopId interno no coincide con el directorio descubierto`,
			);
			return undefined;
		}
		const parsed = parseLoopStateSnapshot(raw);
		return parsed?.state.loopId === loopId ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** API compatible para consumidores que solo necesitan un snapshot runtime seguro. */
export async function readSidecar(ctx: ExtensionContext, loopId: string): Promise<LoopState | undefined> {
	return (await readSidecarSnapshot(ctx, loopId))?.state;
}

/** Descubrimiento best-effort de loopIds que existen solo en estado sidecar. */
export async function discoverSidecarLoopIds(ctx: ExtensionContext): Promise<string[]> {
	try {
		const dirents = await fs.readdir(loopStateRoot(ctx), { withFileTypes: true });
		return dirents
			.filter((dirent) => dirent.isDirectory() && isValidLoopId(dirent.name))
			.map((dirent) => dirent.name);
	} catch {
		return [];
	}
}

/**
 * Elige el más nuevo de dos snapshots por updatedAt (los strings ISO comparan léxicamente
 * porque comparten formato; updatedAt ausente se trata como lo más viejo). En igualdad,
 * un estado terminal gana sobre uno activo para no resucitar trabajo detenido; cualquier
 * otro empate conserva la precedencia determinista del primer argumento.
 */
export function newerState(a: LoopState | undefined, b: LoopState | undefined): LoopState | undefined {
	if (!a) return b;
	if (!b) return a;
	const ta = a.updatedAt ?? "";
	const tb = b.updatedAt ?? "";
	if (tb > ta) return b;
	if (tb < ta) return a;
	const aIsTerminal = TERMINAL_STATUSES.has(a.status);
	const bIsTerminal = TERMINAL_STATUSES.has(b.status);
	if (aIsTerminal !== bIsTerminal) return bIsTerminal ? b : a;
	return a;
}
