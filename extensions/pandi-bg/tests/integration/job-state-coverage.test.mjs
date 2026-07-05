#!/usr/bin/env node
/**
 * Cobertura de caracterización para `extensions/pandi-bg/job-state.ts`: helpers de proyección
 * read-time (projectState / decorateStatus). Afirman el comportamiento ACTUAL del código fuente;
 * el código fuente es la fuente de verdad.
 *
 * Nota de bootstrap (diverge intencionalmente del sibling bg-jobs.test.mjs): para manejar el
 * short-circuit de ownership debemos mutar el MISMO map `activeJobs` que lee job-state.ts.
 * esbuild inlinea `./runtime-state.js` en un bundle normal, lo que ocultaría ese singleton.
 * Por eso bundleamos job-state.ts con `--external:./runtime-state.js` y proveemos nuestro propio
 * runtime-state.js (un Map real más asString/asNumber byte-identical) junto al bundle: Node
 * resuelve el único specifier relativo al archivo que controlamos, así que el test y el módulo
 * comparten una instancia `activeJobs`. process-liveness.js queda bundleado (real), así que el
 * contraste non-owned realmente prueba un pid reaped.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Bundlea job-state.ts manteniendo runtime-state.js external para que el test pueda compartir
// el singleton in-process `activeJobs` con el módulo bajo prueba.
async function buildJobState() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-job-state-"));
	await fs.writeFile(
		path.join(outDir, "runtime-state.js"),
		"export const activeJobs = new Map();\n" +
			'export const asString = (v) => (typeof v === "string" ? v : undefined);\n' +
			'export const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);\n',
	);
	const out = path.join(outDir, "job-state.mjs");
	const r = spawnSync(
		"npx",
		[
			"--no-install",
			"esbuild",
			path.join(REPO_ROOT, "extensions", "pandi-bg", "job-state.ts"),
			"--bundle",
			"--platform=node",
			"--format=esm",
			"--external:./runtime-state.js",
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return {
		moduleUrl: pathToFileURL(out).href,
		runtimeStateUrl: pathToFileURL(path.join(outDir, "runtime-state.js")).href,
	};
}

// Brecha 1: un job poseído (registrado en activeJobs) o un estado persistido terminal es un
// passthrough puro del estado persistido; la prueba de liveness hace short-circuit, así que no
// se adjunta `persistedState`/`hint` aunque el pid registrado esté muerto hace rato.
async function ownedJobShortCircuitsLivenessProbe(moduleUrl, runtimeStateUrl) {
	const { projectState, decorateStatus, deriveState } = await loadModule(moduleUrl);
	// Import plano (SIN query de cache-busting) para compartir el singleton `activeJobs` exacto
	// al que resuelve el import `./runtime-state.js` del bundle.
	const { activeJobs } = await import(runtimeStateUrl);

	// Un pid reaped: spawnSync espera la salida, así que este pid está muerto cuando lo probamos.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"setup: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);

	const jobId = "owned-job";
	activeJobs.set(jobId, {});
	try {
		const owned = projectState(jobId, "running", dead.pid);
		check("owned: persisted running passes through unchanged", owned.state === "running", JSON.stringify(owned));
		check(
			"owned: no persistedState attached (probe skipped)",
			owned.persistedState === undefined,
			JSON.stringify(owned),
		);
		check("owned: no verify-before-kill hint attached", owned.hint === undefined, JSON.stringify(owned));

		// Contraste: el MISMO pid muerto, NO poseído, toma la rama de prueba -> no 'running'.
		const orphanGap = projectState("not-owned-job", "running", dead.pid);
		check(
			"contrast: an unowned dead-pid running job is re-derived away from running",
			orphanGap.state === "interrupted" && orphanGap.persistedState === "running",
			JSON.stringify(orphanGap),
		);

		// decorateStatus espeja el short-circuit y estampa active=true para un job poseído.
		const decorated = decorateStatus(jobId, { state: "running", pid: dead.pid });
		check(
			"owned: decorateStatus keeps running and marks active",
			decorated.state === "running" && decorated.active === true,
			JSON.stringify(decorated),
		);
		check(
			"owned: decorateStatus attaches no persistedState/hint",
			decorated.persistedState === undefined && decorated.hint === undefined,
			JSON.stringify(decorated),
		);

		// deriveState es el accessor fino .state sobre projectState; también passthrough poseído.
		check(
			"owned: deriveState returns the passthrough state",
			deriveState(jobId, { state: "running", pid: dead.pid }) === "running",
		);
	} finally {
		activeJobs.delete(jobId);
	}

	// Un estado persistido terminal es passthrough sin importar ownership (nunca se prueba).
	const terminal = projectState("terminal-job", "completed", dead.pid);
	check(
		"terminal: completed passes through with no probe metadata",
		terminal.state === "completed" && terminal.persistedState === undefined && terminal.hint === undefined,
		JSON.stringify(terminal),
	);
}

// Brecha 2: decorateStatus setea `active` desde membresía en activeJobs y devuelve una copia
// NO mutante; un objeto raw congelado para un job no poseído no debe lanzar y debe quedar intacto.
async function decorateStatusIsNonMutatingAndSetsActive(moduleUrl, runtimeStateUrl) {
	const { decorateStatus } = await loadModule(moduleUrl);
	const { activeJobs } = await import(runtimeStateUrl);
	check(
		"setup: registry starts without the probed job",
		!activeJobs.has("frozen-job"),
		String([...activeJobs.keys()]),
	);

	const raw = Object.freeze({ state: "completed", pid: 12345, extra: "keep-me" });
	let threw = false;
	let result;
	try {
		result = decorateStatus("frozen-job", raw);
	} catch {
		threw = true;
	}
	check("non-mutating: decorating a frozen unowned status does not throw", !threw);
	check("non-mutating: result.active is false for an unowned job", result?.active === false, JSON.stringify(result));
	check("non-mutating: original raw.state is unchanged", raw.state === "completed");
	check("non-mutating: original raw was not given an active flag", !("active" in raw));
	check(
		"non-mutating: unrelated fields are carried onto the copy",
		result?.extra === "keep-me" && result?.pid === 12345,
		JSON.stringify(result),
	);
	check("non-mutating: returned object is a distinct copy", result !== raw);
}

async function main() {
	const { moduleUrl, runtimeStateUrl } = await buildJobState();
	await ownedJobShortCircuitsLivenessProbe(moduleUrl, runtimeStateUrl);
	await decorateStatusIsNonMutatingAndSetsActive(moduleUrl, runtimeStateUrl);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
