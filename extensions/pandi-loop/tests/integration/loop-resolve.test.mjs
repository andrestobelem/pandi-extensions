/**
 * Tests chicos para el resolver de loops elegibles de `/loop`.
 *
 * El módulo es puro salvo por el selector UI opcional: recibe el registro runtime y
 * decide qué loop corresponde por id, candidato único o selección humana.
 *
 * Ejecutarlo:
 *   node extensions/pandi-loop/tests/integration/loop-resolve.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadModule, makeBuildDir } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildResolve() {
	const { outDir, aliases } = await makeBuildDir("pi-loop-resolve");
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "loop-resolve.ts"),
		outDir,
		outName: "loop-resolve.mjs",
		aliases,
	});
	return { url };
}

function loop(loopId, status = "running", task = `task ${loopId}`) {
	return { loopId, status, task };
}

async function resolveContract(url) {
	const { resolveLoop } = await loadModule(url);
	check("resolveLoop is exported", typeof resolveLoop === "function");

	const running = loop("run-a", "running");
	const paused = loop("pause-a", "paused");
	const stopped = loop("stop-a", "stopped");
	const registry = new Map([
		[running.loopId, running],
		[paused.loopId, paused],
		[stopped.loopId, stopped],
	]);
	const headless = { hasUI: false, ui: {} };

	check(
		"id: returns a matching loop with an allowed status",
		(await resolveLoop(headless, registry, "run-a")) === running,
	);
	check(
		"id: rejects a matching loop with a disallowed status",
		(await resolveLoop(headless, registry, "pause-a", ["running"])) === undefined,
	);
	check("id: can allow paused explicitly", (await resolveLoop(headless, registry, "pause-a", ["paused"])) === paused);
	check("id: unknown returns undefined", (await resolveLoop(headless, registry, "missing")) === undefined);

	check(
		"auto: no candidates returns undefined",
		(await resolveLoop(headless, new Map(), undefined, ["running"])) === undefined,
	);
	check(
		"auto: one candidate returns it without UI",
		(await resolveLoop(headless, new Map([[running.loopId, running]]), undefined, ["running"])) === running,
	);
	check(
		"auto: multiple candidates without UI returns undefined",
		(await resolveLoop(headless, registry, undefined, ["running", "paused"])) === undefined,
	);

	const selectCalls = [];
	const uiCtx = {
		hasUI: true,
		ui: {
			select: async (title, options) => {
				selectCalls.push({ title, options });
				return options[1];
			},
		},
	};
	check(
		"ui: selected candidate is returned",
		(await resolveLoop(uiCtx, registry, undefined, ["running", "paused"])) === paused,
	);
	check("ui: prompt title is stable", selectCalls[0]?.title === "¿Qué loop?");
	check(
		"ui: options include id and task",
		selectCalls[0]?.options.join("|") === "run-a — task run-a|pause-a — task pause-a",
	);

	const cancelCtx = { hasUI: true, ui: { select: async () => undefined } };
	check(
		"ui: cancelled selection returns undefined",
		(await resolveLoop(cancelCtx, registry, undefined, ["running", "paused"])) === undefined,
	);
}

async function main() {
	const { url } = await buildResolve();
	await resolveContract(url);

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
