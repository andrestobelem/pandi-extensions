#!/usr/bin/env node
/**
 * Regresión: dos resumes CONCURRENTES del mismo run no deben ejecutarse ambos.
 *
 * Review Farley 2026-07-03, hallazgo #1 (High): resumeWorkflow chequea
 * `activeRuns.has(runId)` y después espera resolveWorkflow/readFile/loadJournal/…
 * antes de que startWorkflowBackground/runWorkflowWithUi registre finalmente el run,
 * así que dos resumes disparados en el mismo tick pasaban el guard y ambos manejaban
 * runWorkflow contra el MISMO runDir/journal (agentes duplicados, clobbering de artifacts,
 * status corrupto).
 *
 * Contrato fijado acá:
 *   - Disparar action=resume dos veces sin esperar la primera: exactamente UNA llamada
 *     ejecuta; la otra se rechaza con error "already active/being resumed"
 *     (sin doble ejecución silenciosa).
 *   - Un resume secuencial después de que termina el primero todavía funciona (la reserva
 *     se libera al completar), y solo se rechaza para estados no resumibles.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

// Duerme para que ambos resumes se solapen, luego falla para que el run siga resumible.
const WORKFLOW = [
	"export const meta = { name: 'race', description: 'resume race probe' };",
	"await sleep(500);",
	"throw new Error('boom (stays resumable)');",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-resume-race",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools };
}

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

const settle = (p) =>
	p.then(
		(v) => ({ ok: true, v }),
		(e) => ({ ok: false, msg: String(e?.message ?? e) }),
	);

// Un intento de resume "ejecutó" salvo que se haya rechazado como already active/resuming.
const wasRejectedAsActive = (r) => {
	if (!r.ok) return /already (active|being resumed|resuming)/i.test(r.msg);
	const text = JSON.stringify(r.v ?? "");
	return /already (active|being resumed|resuming)/i.test(text);
};

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-resume-race-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "race.js"), `${WORKFLOW}\n`, "utf8");
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);
	const run = (params) =>
		tool.execute(`tc-${Math.random().toString(36).slice(2)}`, params, new AbortController().signal, undefined, ctx);

	// Seed: un run failed (resumible).
	const first = await settle(run({ action: "run", name: "race", input: {}, timeoutMs: 30_000 }));
	const runsDir = path.join(project, ".pi", "workflows", "runs");
	const runIds = (await fs.readdir(runsDir)).filter((d) => d.includes("race"));
	check("seed run left exactly one run dir", runIds.length === 1, JSON.stringify({ first, runIds }));
	const runId = runIds[0];

	// La race: dos resumes en el mismo tick.
	const [a, b] = await Promise.all([
		settle(run({ action: "resume", name: runId, timeoutMs: 30_000 })),
		settle(run({ action: "resume", name: runId, timeoutMs: 30_000 })),
	]);
	const rejectedAsActive = [a, b].filter(wasRejectedAsActive).length;
	check(
		"exactly one concurrent resume is rejected as already active",
		rejectedAsActive === 1,
		JSON.stringify({ a: a.ok ? "(ran)" : a.msg, b: b.ok ? "(ran)" : b.msg }),
	);

	// Reserva liberada: un resume secuencial posterior llega a la validación normal
	// (ejecuta otra vez — el run sigue failed/resumible — no "already active").
	const later = await settle(run({ action: "resume", name: runId, timeoutMs: 30_000 }));
	check(
		"sequential resume afterwards is not blocked by a stale reservation",
		!wasRejectedAsActive(later),
		later.ok ? "(ran)" : later.msg,
	);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
