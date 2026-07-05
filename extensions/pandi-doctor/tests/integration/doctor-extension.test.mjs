#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pandi-doctor/index.ts.
 *
 * `/doctor` is a thin in-session convenience that spawns the extension's vendored
 * read-only environment check (extensions/pandi-doctor/scripts/doctor.mjs) and shows
 * its report. Honest evidence:
 *   - the /doctor command is actually registered;
 *   - resolveDoctorScript walks up from a cwd to find the working-tree copy of
 *     extensions/pandi-doctor/scripts/doctor.mjs, falls back to the extension's own
 *     vendored copy (<extDir>/scripts/doctor.mjs), and returns null when neither
 *     resolves;
 *   - runDoctorCheck (driven by an INJECTED fake runner) maps ok/exit/spawnError
 *     to the right notify text + type, deterministically;
 *   - the missing-binary path is exercised with a REAL spawn of a guaranteed-absent
 *     binary (so spawnError is real, not mocked) → bounded message, no crash;
 *   - the command handler runs end-to-end against the REAL repo doctor and calls
 *     ctx.ui.notify once with non-empty text (env-agnostic: info or error).
 *
 * doctor.mjs is spawned with an ARGV array (never a shell string).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.resolve(__dirname, "..", "..");

const { check, counts } = createChecker();

/** Where the vendored doctor script lives, relative to a suite/working-tree root. */
const VENDORED_REL = path.join("extensions", "pandi-doctor", "scripts", "doctor.mjs");

async function buildBundle() {
	// index.ts uses the SDK for types only (erased); stub it so esbuild does not pull
	// the real @earendil-works/pi-coding-agent runtime.
	return await buildExtension({
		name: "pi-doctor-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-doctor", "index.ts"),
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
	const opts = [];
	let i = 0;
	const run = async (scriptPath, runOpts) => {
		calls.push(scriptPath);
		opts.push(runOpts);
		const result = typeof scripted === "function" ? scripted(scriptPath) : scripted[i++];
		return result ?? { ok: true, stdout: "", stderr: "", exitCode: 0 };
	};
	run.calls = calls;
	run.opts = opts;
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

	// From the repo root, walking up finds the vendored extensions/pandi-doctor/scripts/doctor.mjs.
	const fromRoot = mod.resolveDoctorScript(REPO_ROOT, "/nonexistent/ext");
	check(
		"resolveDoctorScript: finds the vendored script from repo root",
		typeof fromRoot === "string" && fromRoot.endsWith(VENDORED_REL),
		String(fromRoot),
	);

	// From a nested repo subdir, walking up still finds it.
	const fromSubdir = mod.resolveDoctorScript(path.join(REPO_ROOT, "extensions", "pandi-doctor"), "/nonexistent/ext");
	check(
		"resolveDoctorScript: finds it from a nested subdir",
		typeof fromSubdir === "string" && fromSubdir.endsWith(VENDORED_REL),
		String(fromSubdir),
	);

	// Extension-relative fallback: cwd is unrelated, but extDir carries its own copy.
	const fromFallback = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, EXT_DIR);
	check(
		"resolveDoctorScript: falls back to the extension's own scripts/doctor.mjs",
		typeof fromFallback === "string" && fromFallback === path.join(EXT_DIR, "scripts", "doctor.mjs"),
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
			String(run.calls[0]).endsWith(VENDORED_REL),
			String(run.calls[0]),
		);
	}

	// The runner receives the SESSION cwd (doctor.mjs discovers the suite root from
	// there), not the script's grandparent directory.
	{
		const nestedCwd = path.join(REPO_ROOT, "extensions");
		const run = fakeRunner([{ ok: true, stdout: "ok", stderr: "", exitCode: 0 }]);
		await mod.runDoctorCheck(run, { cwd: nestedCwd, extDir: EXT_DIR });
		check("runDoctorCheck: spawns with the session cwd", run.opts[0]?.cwd === nestedCwd, JSON.stringify(run.opts[0]));
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
			res.type === "warning" && /pandi-extensions/i.test(res.text) && run.calls.length === 0,
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

function scenarioStandaloneDoctor() {
	// Copy ONLY the vendored script to a temp dir outside the repo (like an npm
	// install of @pandi-coding-agent/pandi-doctor) and run it for REAL from a non-repo
	// cwd: it must degrade gracefully, not assume the suite repo exists.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-standalone-"));
	try {
		const extDir = path.join(tmp, "ext");
		fs.mkdirSync(path.join(extDir, "scripts"), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), path.join(extDir, "scripts", "doctor.mjs"));
		const agentDir = path.join(tmp, "agent"); // empty seam: host settings must not leak in
		fs.mkdirSync(agentDir, { recursive: true });
		const r = spawnSync("node", [path.join(extDir, "scripts", "doctor.mjs")], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 60000,
			env: { ...process.env, NO_COLOR: "1", PI_DOCTOR_AGENT_DIR: agentDir },
		});
		const out = `${r.stdout || ""}${r.stderr || ""}`;
		check("standalone: exits 0/1 without crashing", r.status === 0 || r.status === 1, `status=${r.status}`);
		check("standalone: prints the doctor report", out.includes("pandi-extensions doctor"), out.slice(0, 200));
		const syncLine = out.split("\n").find((l) => l.includes("sync Claude global")) ?? "";
		check("standalone: sync Claude global is N/A outside the repo", syncLine.includes("N/A"), syncLine);
		const hookLine = out.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("standalone: hook pre-commit is N/A outside the repo", hookLine.includes("N/A"), hookLine);
		check("standalone: no reference to this repo's path", !out.includes(REPO_ROOT), out.slice(0, 400));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function scenarioPreCommitHookCheck() {
	// Inside a suite-like git repo, doctor must report whether the versioned
	// pre-commit hook (scripts/git-hooks + core.hooksPath) is installed:
	// WARN when missing, OK once `git config core.hooksPath scripts/git-hooks`
	// points at an existing hook file.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hook-"));
	try {
		spawnSync("git", ["init", "-q"], { cwd: tmp, encoding: "utf8", timeout: 10000 });
		fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "pandi-extensions" }));
		const extDir = path.join(tmp, "ext");
		fs.mkdirSync(path.join(extDir, "scripts"), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), path.join(extDir, "scripts", "doctor.mjs"));
		const agentDir = path.join(tmp, "agent"); // empty seam: host settings must not leak in
		fs.mkdirSync(agentDir, { recursive: true });
		const runDoctorHere = () =>
			spawnSync("node", [path.join(extDir, "scripts", "doctor.mjs")], {
				cwd: tmp,
				encoding: "utf8",
				timeout: 60000,
				env: { ...process.env, NO_COLOR: "1", PI_DOCTOR_AGENT_DIR: agentDir },
			});

		const before = `${runDoctorHere().stdout || ""}`;
		const beforeLine = before.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("hook check: reported when not installed", beforeLine.length > 0, before.slice(0, 400));
		check("hook check: WARN + actionable hint when not installed", /⚠/.test(beforeLine), beforeLine);

		// Install: versioned hook file + core.hooksPath, exactly like `npm install` (prepare) does.
		const hooksDir = path.join(tmp, "scripts", "git-hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		spawnSync("git", ["config", "core.hooksPath", "scripts/git-hooks"], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 10000,
		});

		const after = `${runDoctorHere().stdout || ""}`;
		const afterLine = after.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("hook check: OK once hooksPath + hook file are in place", /✓/.test(afterLine), afterLine);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
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
	scenarioStandaloneDoctor();
	scenarioPreCommitHookCheck();
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
