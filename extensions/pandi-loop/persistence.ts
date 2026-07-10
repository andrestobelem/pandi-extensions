/**
 * Helpers de persistencia para la extensión `/loop`, extraídos a un hermano para que
 * index.ts conserve solo el engine/wiring. Están PARAMETRIZADOS (reciben
 * pi/ctx/loop/state como argumentos) y no cierran sobre `activeLoops`, así que se
 * mueven limpiamente. El comportamiento no cambia: mismo append JSONL vía
 * pi.appendEntry + escritura sidecar atómica (archivo temporal y luego rename), misma
 * semántica de tragar errores.
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
import { type ActiveLoop, type LoopState, snapshot } from "./state.js";

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
	loop.updatedAt = new Date().toISOString();
	const snap = snapshot(loop);
	pi.appendEntry<LoopState>(LOOP_STATE_TYPE, snap);
	// Sidecar atómico best-effort (nunca lanza al engine).
	void writeSidecar(ctx, snap).catch(() => {});
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

/** Lee un sidecar state.json para un loopId, o undefined si falta o está corrupto. */
export async function readSidecar(ctx: ExtensionContext, loopId: string): Promise<LoopState | undefined> {
	try {
		const file = path.join(loopStateDir(ctx, loopId), STATE_FILE);
		const body = await fs.readFile(file, "utf8");
		const data = JSON.parse(body) as LoopState;
		if (!data || typeof data.loopId !== "string") return undefined;
		return data;
	} catch {
		return undefined;
	}
}

/** Descubrimiento best-effort de loopIds que existen solo en estado sidecar. */
export async function discoverSidecarLoopIds(ctx: ExtensionContext): Promise<string[]> {
	try {
		const dirents = await fs.readdir(loopStateRoot(ctx), { withFileTypes: true });
		return dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
	} catch {
		return [];
	}
}

/**
 * Elige el más nuevo de dos snapshots por updatedAt (los strings ISO comparan léxicamente
 * porque comparten formato; updatedAt ausente se trata como lo más viejo). Usado para resolver
 * conflictos JSONL-vs-sidecar: gana el que se escribió último.
 */
export function newerState(a: LoopState | undefined, b: LoopState | undefined): LoopState | undefined {
	if (!a) return b;
	if (!b) return a;
	const ta = a.updatedAt ?? "";
	const tb = b.updatedAt ?? "";
	return tb > ta ? b : a;
}
