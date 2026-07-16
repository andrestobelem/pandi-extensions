#!/usr/bin/env node
/**
 * Test unitario de las funciones puras de pandi-kitty (constructores de argv +
 * manejadores de alto nivel con un runner inyectado). No arranca kitty real.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBundle(src, outName) {
	return await buildExtension({
		name: "pi-kitty-build",
		src,
		outName,
	});
}

async function main() {
	const { url } = await buildBundle(path.join(REPO_ROOT, "extensions", "pandi-kitty", "kitty.ts"), "kitty.mjs");
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

	check("runKitty: timeout escalates SIGTERM to SIGKILL", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-kitty-timeout-"));
		try {
			fs.writeFileSync(
				path.join(dir, "@"),
				'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000); setTimeout(() => process.exit(23), 3_000);',
			);
			const startedAt = Date.now();
			const result = await mod.runKitty(["ignored"], { bin: process.execPath, cwd: dir, timeoutMs: 1_000 });
			assert.equal(result.ok, false);
			assert.equal(result.timedOut, true);
			assert.ok(Date.now() - startedAt < 2_000, `elapsed=${Date.now() - startedAt}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	check("runGotoLayout: sin layout -> error", async () => {
		const result = await mod.runGotoLayout(async () => ({ ok: true, stdout: "", stderr: "" }), { layout: "" }, {});
		assert.equal(result.ok, false);
	});

	check("kitty_remote: acción inválida -> toolError canónico", async () => {
		const bundle = await buildBundle(path.join(REPO_ROOT, "extensions", "pandi-kitty", "index.ts"), "index.mjs");
		const extensionModule = await loadModule(bundle.url);
		let registeredTool;
		extensionModule.default({
			registerCommand() {},
			registerTool(tool) {
				registeredTool = tool;
			},
		});

		assert.ok(registeredTool);
		const result = await registeredTool.execute("call-1", { action: "invalida" }, null, undefined, {
			cwd: REPO_ROOT,
		});
		assert.match(result.content[0].text, /acción desconocida/i);
		assert.equal(result.details.isError, true);
	});

	console.log(`\n${counts.passed} pasaron, ${counts.failed} fallaron.`);
	if (counts.failed > 0) process.exitCode = 1;
}

main();
