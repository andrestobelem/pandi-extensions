#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-doctor/index.ts.
 *
 * `/doctor` is a thin in-session convenience that spawns the repo's read-only
 * environment check (scripts/doctor.mjs) and shows its report. Honest evidence:
 *   - the /doctor command is actually registered;
 *   - resolveDoctorScript walks up from a cwd to find scripts/doctor.mjs, and
 *     returns null when neither cwd nor the extension-relative fallback resolves;
 *   - runDoctorCheck (driven by an INJECTED fake runner) maps ok/exit/spawnError
 *     to the right notify text + type, deterministically;
 *   - the missing-binary path is exercised with a REAL spawn of a guaranteed-absent
 *     binary (so spawnError is real, not mocked) → bounded message, no crash;
 *   - the command handler runs end-to-end against the REAL repo doctor and calls
 *     ctx.ui.notify once with non-empty text (env-agnostic: info or error).
 *
 * doctor.mjs is spawned with an ARGV array (never a shell string).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.resolve(__dirname, "..", "..");

const { check, counts } = createChecker();

async function buildBundle() {
	// index.ts uses the SDK for types only (erased); stub it so esbuild does not pull
	// the real @earendil-works/pi-coding-agent runtime.
	return await buildExtension({
		name: "pi-doctor-build",
		src: path.join(REPO_ROOT, "extensions", "pi-doctor", "index.ts"),
		outName: "doctor.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	const events = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
			on: (event, handler) => events.set(event, handler),
		},
		commands,
		tools,
		events,
	};
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

/** A fake runner matching runDoctor's signature; records calls, returns canned results. */
function fakeRunner(scripted = []) {
	const calls = [];
	let i = 0;
	const run = async (scriptPath, _opts) => {
		calls.push(scriptPath);
		const result = typeof scripted === "function" ? scripted(scriptPath) : scripted[i++];
		return result ?? { ok: true, stdout: "", stderr: "", exitCode: 0 };
	};
	run.calls = calls;
	return run;
}

async function scenarioRegistration(url) {
	const { commands } = await loadExtension(url);
	check("registers /doctor command", commands.has("doctor"), [...commands.keys()].join(","));
	check("handler is a function", typeof commands.get("doctor")?.handler === "function");
	check("command has a description", typeof commands.get("doctor")?.description === "string");
}

async function scenarioResolver(url) {
	const mod = await loadModule(url);

	// From the repo root, walking up finds scripts/doctor.mjs.
	const fromRoot = mod.resolveDoctorScript(REPO_ROOT, "/nonexistent/ext");
	check(
		"resolveDoctorScript: finds scripts/doctor.mjs from repo root",
		typeof fromRoot === "string" && fromRoot.endsWith(path.join("scripts", "doctor.mjs")),
		String(fromRoot),
	);

	// From a nested repo subdir, walking up still finds it.
	const fromSubdir = mod.resolveDoctorScript(path.join(REPO_ROOT, "extensions", "pi-doctor"), "/nonexistent/ext");
	check(
		"resolveDoctorScript: finds it from a nested subdir",
		typeof fromSubdir === "string" && fromSubdir.endsWith(path.join("scripts", "doctor.mjs")),
		String(fromSubdir),
	);

	// Extension-relative fallback: cwd is unrelated, but extDir points into the repo ext.
	const fromFallback = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, EXT_DIR);
	check(
		"resolveDoctorScript: falls back to extension-relative script",
		typeof fromFallback === "string" && fromFallback.endsWith(path.join("scripts", "doctor.mjs")),
		String(fromFallback),
	);

	// Neither cwd nor fallback resolves → null.
	const none = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, "/nonexistent/ext");
	check("resolveDoctorScript: null when nothing resolves", none === null, String(none));
}

async function scenarioCheckLogic(url) {
	const mod = await loadModule(url);

	// ok run → info, report text passed through.
	{
		const run = fakeRunner([{ ok: true, stdout: "✓ all mandatory present\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: ok → info + report text",
			res.type === "info" && res.text.includes("all mandatory present") && run.calls.length === 1,
			JSON.stringify(res),
		);
		check(
			"runDoctorCheck: spawns the resolved doctor.mjs",
			String(run.calls[0]).endsWith(path.join("scripts", "doctor.mjs")),
			String(run.calls[0]),
		);
	}

	// exit 1 (mandatory missing) → error.
	{
		const run = fakeRunner([{ ok: false, stdout: "✗ Pi CLI missing\n", stderr: "", exitCode: 1 }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: exit 1 → error",
			res.type === "error" && res.text.includes("Pi CLI missing"),
			JSON.stringify(res),
		);
	}

	// spawnError → bounded error message, no throw.
	{
		const run = fakeRunner([{ ok: false, spawnError: "spawn node ENOENT" }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: spawnError → error + mentions the failure",
			res.type === "error" && /ENOENT|could not run/i.test(res.text),
			JSON.stringify(res),
		);
	}

	// script not found → warning that points at the repo, runner NOT called.
	{
		const run = fakeRunner([{ ok: true, stdout: "should not run", stderr: "", exitCode: 0 }]);
		const res = await mod.runDoctorCheck(run, { cwd: path.parse(REPO_ROOT).root, extDir: "/nonexistent/ext" });
		check(
			"runDoctorCheck: script not found → warning, runner not called",
			res.type === "warning" && /pi-dynamic-workflows/i.test(res.text) && run.calls.length === 0,
			JSON.stringify(res),
		);
	}
}

async function scenarioRealSpawnMissingBin(url) {
	const mod = await loadModule(url);
	// REAL spawn of a guaranteed-absent binary → spawnError is real, message bounded.
	const script = mod.resolveDoctorScript(REPO_ROOT, EXT_DIR);
	const result = await mod.runDoctor(script, { bin: "node-does-not-exist-xyz", timeoutMs: 5000 });
	check("runDoctor: missing bin → ok=false", result.ok === false, JSON.stringify(result));
	check(
		"runDoctor: missing bin → spawnError set",
		typeof result.spawnError === "string" && result.spawnError.length > 0,
		JSON.stringify(result),
	);
}

async function scenarioHandlerEndToEnd(url) {
	const extension = await loadDefault(url);
	const { pi, commands } = makePi();
	extension(pi);
	const notifications = [];
	const ctx = {
		mode: "interactive",
		hasUI: true,
		cwd: REPO_ROOT,
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
	// Runs the REAL scripts/doctor.mjs against this repo; env-agnostic assertion.
	await commands.get("doctor").handler("", ctx);
	check("handler: notifies exactly once", notifications.length === 1, `count=${notifications.length}`);
	check(
		"handler: notification has non-empty text and a valid type",
		typeof notifications[0]?.message === "string" &&
			notifications[0].message.trim().length > 0 &&
			["info", "warning", "error"].includes(notifications[0]?.type),
		JSON.stringify(notifications[0]),
	);
}

async function main() {
	const { url } = await buildBundle();
	await scenarioRegistration(url);
	await scenarioResolver(url);
	await scenarioCheckLogic(url);
	await scenarioRealSpawnMissingBin(url);
	await scenarioHandlerEndToEnd(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
