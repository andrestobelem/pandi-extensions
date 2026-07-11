/**
 * Handlers de limpieza: delete, prune.
 */

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BgResponse, rejectInPlanMode, resolveRunDir, response } from "./command-shared.js";
import { eachProjectRunDir } from "./job-listing.js";
import { projectState, refineOrphanedIdentity } from "./job-state.js";
import { activeJobs, asNumber, asString } from "./runtime-state.js";
import { dirSizeBytes, getProjectBgRoot, parsePruneFlags, RUNS_DIR, readJson, removeRunDir } from "./storage.js";

// Únicos estados en los que pueden eliminarse los artifacts de un job terminado.
const DELETABLE_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function classifyForDeletion(
	jobId: string,
	status: Record<string, unknown> | undefined,
): { liveState: string; deletable: boolean; reason?: string } {
	if (activeJobs.has(jobId)) return { liveState: "running", deletable: false, reason: "está activo en esta sesión" };
	const pid = asNumber(status?.pid);
	let state: string = projectState(jobId, asString(status?.state), pid).state;
	if (state === "orphaned") state = refineOrphanedIdentity(pid, asString(status?.startId)).state;
	if (DELETABLE_STATES.has(state)) return { liveState: state, deletable: true };
	const reason =
		state === "orphaned"
			? "su proceso sigue vivo (o no se puede verificar su identidad)"
			: state === "stale"
				? "no se puede comprobar si sigue vivo"
				: `no está en un estado terminal (${state})`;
	return { liveState: state, deletable: false, reason };
}

export async function handlePrune(ctx: ExtensionContext, tail: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("prune");
	if (blocked) return blocked;
	if (!ctx.isProjectTrusted())
		return response(
			"No se puede ejecutar /bg prune en un proyecto no confiable.",
			{ action: "prune", blockedBy: "trust" },
			"warning",
		);
	const { yes } = parsePruneFlags(tail);
	const candidates: { jobId: string; state: string; bytes: number }[] = [];
	const skipped: { jobId: string; state: string; reason: string }[] = [];
	for (const { jobId, runDir, status } of await eachProjectRunDir(ctx)) {
		const verdict = classifyForDeletion(jobId, status);
		if (verdict.deletable) candidates.push({ jobId, state: verdict.liveState, bytes: await dirSizeBytes(runDir) });
		else skipped.push({ jobId, state: verdict.liveState, reason: verdict.reason ?? "no se puede eliminar" });
	}
	const totalBytes = candidates.reduce((sum, c) => sum + c.bytes, 0);
	if (yes) {
		const deleted: string[] = [];
		for (const c of candidates) {
			if (
				await removeRunDir(
					ctx,
					c.jobId,
					{ verb: "prune", state: c.state, sizeBytes: c.bytes },
					(reread) => classifyForDeletion(c.jobId, reread).deletable,
				)
			)
				deleted.push(c.jobId);
		}
		const execLines = [
			`Se eliminaron ${deleted.length} de ${candidates.length} job(s) candidato(s) (${skipped.length} omitido(s)).`,
			...deleted.map((id) => `  eliminado ${id}`),
		];
		return response(execLines.join("\n"), {
			action: "prune",
			dryRun: false,
			deleted,
			skipped,
			totalBytes,
		});
	}
	const lines = [
		`Vista previa de prune: ${candidates.length} eliminable(s) (${totalBytes} bytes), ${skipped.length} omitido(s).`,
		...candidates.map((c) => `  eliminar ${c.jobId} · ${c.state} · ${c.bytes}B`),
		...skipped.map((s) => `  omitir  ${s.jobId} · ${s.state} · ${s.reason}`),
		candidates.length ? `Ejecutá /bg prune --yes para eliminar ${candidates.length} job(s).` : "Nada para eliminar.",
	];
	return response(lines.join("\n"), {
		action: "prune",
		dryRun: true,
		candidates,
		skipped,
		totalBytes,
	});
}

export async function handleDelete(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("delete");
	if (blocked) return blocked;
	if (!ctx.isProjectTrusted())
		return response(
			"No se puede ejecutar /bg delete en un proyecto no confiable.",
			{ action: "delete", blockedBy: "trust" },
			"warning",
		);
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg delete <jobId>");
	if (typeof runDir !== "string") return runDir;
	const projectRuns = path.join(getProjectBgRoot(ctx), RUNS_DIR);
	if (!path.resolve(runDir).startsWith(path.resolve(projectRuns) + path.sep)) {
		return response(
			`El job en segundo plano ${jobId} vive en el almacén global de respaldo (solo lectura); /bg delete solo elimina jobs locales del proyecto.`,
			{ action: "delete", jobId, deleted: false, scope: "global" },
			"warning",
		);
	}
	const status = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const verdict = classifyForDeletion(jobId, status);
	if (!verdict.deletable) {
		return response(
			`El job en segundo plano ${jobId} no se puede eliminar: ${verdict.reason}.`,
			{ action: "delete", jobId, deleted: false, liveState: verdict.liveState },
			"warning",
		);
	}
	const removed = await removeRunDir(
		ctx,
		jobId,
		{ verb: "delete", state: verdict.liveState },
		(reread) => classifyForDeletion(jobId, reread).deletable,
	);
	if (!removed)
		return response(
			`Job en segundo plano no encontrado: ${jobId}`,
			{ action: "delete", jobId, deleted: false },
			"warning",
		);
	return response(`Job en segundo plano ${jobId} eliminado.`, { action: "delete", jobId, deleted: true });
}
