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

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

const BARRIER_STARTED = ".pi/workflows/resume-race-started";
const BARRIER_RELEASE = ".pi/workflows/resume-race-release";

// Espera una señal del test para que los resumes se solapen de forma observable, luego falla para
// que el run siga resumible. No hay delay fijo para "dar tiempo": el test libera la barrera cuando
// ve el marker. El sleep interno solo evita un busy-loop mientras espera el archivo de release.
const WORKFLOW = [
	"export const meta = { name: 'race', description: 'resume race probe' };",
	`await writeFile(${JSON.stringify(BARRIER_STARTED)}, "started\\n");`,
	"let released = false;",
	"for (let i = 0; i < 500; i++) {",
	`  try { await readFile(${JSON.stringify(BARRIER_RELEASE)}); released = true; break; }`,
	"  catch { await sleep(20); }",
	"}",
	"if (!released) throw new Error('barrier release timed out');",
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

function barrierPaths(project) {
	return {
		started: path.join(project, BARRIER_STARTED),
		release: path.join(project, BARRIER_RELEASE),
	};
}

async function fileExists(file) {
	try {
		await fs.stat(file);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function waitForFile(file, timeoutMs = 5000) {
	if (await fileExists(file)) return;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await new Promise((resolve, reject) => {
		let done = false;
		let watcher;
		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			watcher?.close();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error(`timeout waiting for ${file}`)), timeoutMs);
		try {
			watcher = fsSync.watch(path.dirname(file), () => {
				fileExists(file).then((ok) => {
					if (ok) finish();
				}, finish);
			});
		} catch (error) {
			finish(error);
			return;
		}
		fileExists(file).then((ok) => {
			if (ok) finish();
		}, finish);
	});
}

async function resetBarrier(project) {
	const barrier = barrierPaths(project);
	await fs.rm(barrier.started, { force: true });
	await fs.rm(barrier.release, { force: true });
}

async function releaseBarrier(project, label) {
	const barrier = barrierPaths(project);
	await fs.writeFile(barrier.release, `${label}\n`, "utf8");
}

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
	await resetBarrier(project);
	const firstPromise = settle(run({ action: "run", name: "race", input: {}, timeoutMs: 30_000 }));
	await waitForFile(barrierPaths(project).started);
	await releaseBarrier(project, "seed");
	const first = await firstPromise;
	await resetBarrier(project);
	const runsDir = path.join(project, ".pi", "workflows", "runs");
	const runIds = (await fs.readdir(runsDir)).filter((d) => d.includes("race"));
	check("seed run left exactly one run dir", runIds.length === 1, JSON.stringify({ first, runIds }));
	const runId = runIds[0];

	// La race: dos resumes en el mismo tick; liberamos el que ejecuta recién cuando la barrera arrancó.
	await resetBarrier(project);
	const resumeA = settle(run({ action: "resume", name: runId, timeoutMs: 30_000 }));
	const resumeB = settle(run({ action: "resume", name: runId, timeoutMs: 30_000 }));
	await waitForFile(barrierPaths(project).started);
	await releaseBarrier(project, "race");
	const [a, b] = await Promise.all([resumeA, resumeB]);
	await resetBarrier(project);
	const rejectedAsActive = [a, b].filter(wasRejectedAsActive).length;
	check(
		"exactly one concurrent resume is rejected as already active",
		rejectedAsActive === 1,
		JSON.stringify({ a: a.ok ? "(ran)" : a.msg, b: b.ok ? "(ran)" : b.msg }),
	);

	// Reserva liberada: un resume secuencial posterior llega a la validación normal
	// (ejecuta otra vez — el run sigue failed/resumible — no "already active").
	const laterPromise = settle(run({ action: "resume", name: runId, timeoutMs: 30_000 }));
	await waitForFile(barrierPaths(project).started);
	await releaseBarrier(project, "later");
	const later = await laterPromise;
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
