#!/usr/bin/env node
/**
 * Test unitario de las funciones puras de pandi-kitty (constructores de argv +
 * manejadores de alto nivel con un runner inyectado). No arranca kitty real.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBundle() {
	return await buildExtension({
		name: "pi-kitty-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-kitty", "kitty.ts"),
		outName: "kitty.mjs",
	});
}

async function main() {
	const { url } = await buildBundle();
	const mod = await loadModule(url);

	check("buildLaunchArgs: tab", () =>
		assert.deepEqual(mod.buildLaunchArgs({ type: "tab" }), ["launch", "--type", "tab"]),
	);

	check("buildLaunchArgs: window + vsplit", () =>
		assert.deepEqual(mod.buildLaunchArgs({ type: "window", location: "vsplit" }), [
			"launch",
			"--type",
			"window",
			"--location",
			"vsplit",
		]),
	);

	check("buildGotoLayoutArgs", () => assert.deepEqual(mod.buildGotoLayoutArgs("splits"), ["goto-layout", "splits"]));

	check("buildCloseWindowArgs: sin match", () => assert.deepEqual(mod.buildCloseWindowArgs(), ["close-window"]));

	check("buildCloseWindowArgs: con match", () =>
		assert.deepEqual(mod.buildCloseWindowArgs({ matchId: "3" }), ["close-window", "--match", "id:3"]),
	);

	check("buildFocusWindowArgs", () =>
		assert.deepEqual(mod.buildFocusWindowArgs("3"), ["focus-window", "--match", "id:3"]),
	);

	check("runLaunch: tipo desconocido -> error sin invocar run", async () => {
		let called = false;
		const run = async () => {
			called = true;
			return { ok: true, stdout: "1", stderr: "" };
		};
		const result = await mod.runLaunch(run, { type: "bogus" }, {});
		assert.equal(result.ok, false);
		assert.equal(called, false);
	});

	check("runLaunch: ok -> devuelve el id parseado", async () => {
		const run = async () => ({ ok: true, stdout: "5\n", stderr: "" });
		const result = await mod.runLaunch(run, { type: "tab" }, {});
		assert.equal(result.ok, true);
		assert.equal(result.details.id, "5");
	});

	check("describeError: spawn ENOENT -> hint de instalación", () => {
		const text = mod.describeError({ ok: false, stdout: "", stderr: "", spawnError: "spawn kitty ENOENT" }, "launch");
		assert.match(text, /no se encontró el binario/i);
	});

	check("runGotoLayout: sin layout -> error", async () => {
		const result = await mod.runGotoLayout(async () => ({ ok: true, stdout: "", stderr: "" }), { layout: "" }, {});
		assert.equal(result.ok, false);
	});

	console.log(`\n${counts.passed} pasaron, ${counts.failed} fallaron.`);
	if (counts.failed > 0) process.exitCode = 1;
}

main();
