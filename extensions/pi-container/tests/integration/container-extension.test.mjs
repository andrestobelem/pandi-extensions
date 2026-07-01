#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-container/index.ts.
 *
 * Apple's `container` runs Linux in real micro-VMs (Apple Silicon + macOS 26 +
 * a booted subsystem), which a CI box cannot spin up. So honest evidence here is:
 *   - pure parsers pinned against REAL captured CLI output (`container machine ls
 *     --format json`), so the parser is tested against the actual contract;
 *   - arg builders asserted exactly (argv, never a shell string);
 *   - high-level action handlers driven by an INJECTED fake runner, so dispatch,
 *     the "remove needs force" gate, and error normalization are deterministic;
 *   - the CLI-missing path exercised with a REAL spawn of a guaranteed-absent
 *     binary (so `spawnError` is real, not mocked) → a bounded message, no crash;
 *   - the /container command and container_sandbox tool are actually registered.
 *
 * `container` is always spawned with an ARGV array (never a shell string), so
 * image refs / machine names / commands cannot inject shell.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBundle() {
	// index.ts uses the SDK for types only (erased); stub it so esbuild does not pull
	// the real @earendil-works/pi-coding-agent runtime (cross-spawn breaks an ESM bundle).
	return await buildExtension({
		name: "pi-container-build",
		src: path.join(REPO_ROOT, "extensions", "pi-container", "index.ts"),
		outName: "container.mjs",
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

/** A fake runner matching runContainer's signature; records calls, returns canned results. */
function fakeRunner(scripted = []) {
	const calls = [];
	let i = 0;
	const run = async (args, _opts) => {
		calls.push(args);
		const result = typeof scripted === "function" ? scripted(args) : scripted[i++];
		return result ?? { ok: true, stdout: "", stderr: "", exitCode: 0 };
	};
	run.calls = calls;
	return run;
}

// Real captured output of `container machine ls --format json` (1.0.0).
const REAL_MACHINE_JSON =
	'[{"memory":19327352832,"diskSize":78790656,"default":true,"id":"dev","ipAddress":"192.168.64.4","createdDate":"2026-06-30T18:48:46Z","cpus":6,"status":"running"}]';

async function scenarioRegistration(url) {
	const { commands, tools } = await loadExtension(url);
	check("registers /container command", commands.has("container"), [...commands.keys()].join(","));
	check("registers container_sandbox tool", tools.has("container_sandbox"), [...tools.keys()].join(","));
	const tool = tools.get("container_sandbox");
	check("tool has execute()", typeof tool?.execute === "function");
	check("tool is sequential", tool?.executionMode === "sequential", String(tool?.executionMode));
}

async function scenarioPureHelpers(url) {
	const mod = await loadModule(url);

	// platform guard
	check("isSupportedPlatform(darwin,arm64) true", mod.isSupportedPlatform("darwin", "arm64") === true);
	check("isSupportedPlatform(darwin,x64) false", mod.isSupportedPlatform("darwin", "x64") === false);
	check("isSupportedPlatform(linux,arm64) false", mod.isSupportedPlatform("linux", "arm64") === false);

	// machine-name validation
	for (const [name, ok] of [
		["dev", true],
		["my-machine_1", true],
		["", false],
		["-x", false],
		["has space", false],
		["a/b", false],
		["a;b", false],
	]) {
		check(`validateMachineName(${JSON.stringify(name)}) === ${ok}`, mod.validateMachineName(name) === ok, name);
	}

	// parser pinned to REAL captured JSON
	const entries = mod.parseMachineList(REAL_MACHINE_JSON);
	check("parseMachineList: one entry", entries.length === 1, String(entries.length));
	const m = entries[0];
	check(
		"parseMachineList: fields",
		m.id === "dev" &&
			m.status === "running" &&
			m.ipAddress === "192.168.64.4" &&
			m.cpus === 6 &&
			m.isDefault === true,
		JSON.stringify(m),
	);
	check("parseMachineList: empty array", mod.parseMachineList("[]").length === 0);
	check("parseMachineList: junk → []", Array.isArray(mod.parseMachineList("not json")));

	// formatter
	const line = mod.formatMachineList(entries);
	check("formatMachineList: mentions id + status", line.includes("dev") && line.includes("running"), line);
	check("formatMachineList: humanizes memory (18G)", /18\s?G/i.test(line), line);
	check(
		"formatMachineList: empty → friendly",
		/no .*machine/i.test(mod.formatMachineList([])),
		mod.formatMachineList([]),
	);
}

async function scenarioArgBuilders(url) {
	const mod = await loadModule(url);
	const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

	eq("buildStatusArgs", mod.buildStatusArgs(), ["system", "status", "--format", "json"]);
	eq("buildMachineListArgs", mod.buildMachineListArgs(), ["machine", "ls", "--format", "json"]);

	eq(
		"buildMachineCreateArgs: full (image last)",
		mod.buildMachineCreateArgs({
			name: "dev",
			image: "alpine:latest",
			cpus: 4,
			memory: "8G",
			homeMount: "ro",
			setDefault: true,
		}),
		[
			"machine",
			"create",
			"-n",
			"dev",
			"--set-default",
			"--cpus",
			"4",
			"--memory",
			"8G",
			"--home-mount",
			"ro",
			"alpine:latest",
		],
	);
	eq("buildMachineCreateArgs: minimal", mod.buildMachineCreateArgs({ image: "alpine:latest" }), [
		"machine",
		"create",
		"alpine:latest",
	]);

	eq(
		"buildMachineExecArgs: argv after --",
		mod.buildMachineExecArgs({ name: "dev", workdir: "/work", command: ["echo", "hi there"] }),
		["machine", "run", "-n", "dev", "-w", "/work", "--", "echo", "hi there"],
	);
	eq("buildMachineExecArgs: default machine, no workdir", mod.buildMachineExecArgs({ command: ["uname", "-a"] }), [
		"machine",
		"run",
		"--",
		"uname",
		"-a",
	]);

	eq(
		"buildEphemeralRunArgs: image before args",
		mod.buildEphemeralRunArgs({ image: "alpine:latest", command: ["echo", "x"] }),
		["run", "--rm", "alpine:latest", "echo", "x"],
	);
	eq(
		"buildEphemeralRunArgs: with workdir",
		mod.buildEphemeralRunArgs({ image: "alpine:latest", workdir: "/w", command: ["pwd"] }),
		["run", "--rm", "-w", "/w", "alpine:latest", "pwd"],
	);

	eq("buildStopArgs: named", mod.buildStopArgs({ name: "dev" }), ["machine", "stop", "dev"]);
	eq("buildStopArgs: default", mod.buildStopArgs({}), ["machine", "stop"]);
	eq("buildRemoveArgs", mod.buildRemoveArgs({ name: "dev" }), ["machine", "delete", "dev"]);
}

async function scenarioHandlers(url) {
	const mod = await loadModule(url);

	// list → parses injected JSON into structured details
	{
		const run = fakeRunner([{ ok: true, stdout: REAL_MACHINE_JSON, stderr: "", exitCode: 0 }]);
		const res = await mod.runList(run, {});
		check("runList: ok", res.ok === true, JSON.stringify(res));
		check("runList: details has machines", res.details?.machines?.length === 1, JSON.stringify(res.details));
		check(
			"runList: called ls --format json",
			JSON.stringify(run.calls[0]) === JSON.stringify(["machine", "ls", "--format", "json"]),
		);
	}

	// exec → builds args + surfaces stdout
	{
		const run = fakeRunner([{ ok: true, stdout: "Linux 6.18.15\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runExec(run, { machine: "dev", command: ["uname", "-sr"] }, {});
		check("runExec: ok", res.ok === true, JSON.stringify(res));
		check("runExec: text carries stdout", res.text.includes("Linux 6.18.15"), res.text);
		check(
			"runExec: argv via machine run -- ",
			JSON.stringify(run.calls[0]) === JSON.stringify(["machine", "run", "-n", "dev", "--", "uname", "-sr"]),
			JSON.stringify(run.calls[0]),
		);
	}

	// exec ephemeral (image, no machine)
	{
		const run = fakeRunner([{ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runExec(run, { image: "alpine:latest", command: ["echo", "ok"] }, {});
		check("runExec ephemeral: ok", res.ok === true);
		check(
			"runExec ephemeral: run --rm image args",
			JSON.stringify(run.calls[0]) === JSON.stringify(["run", "--rm", "alpine:latest", "echo", "ok"]),
			JSON.stringify(run.calls[0]),
		);
	}

	// exec with neither machine nor image → bounded error, no run
	{
		const run = fakeRunner();
		const res = await mod.runExec(run, { command: ["echo", "x"] }, {});
		check("runExec: requires machine or image", res.ok === false && run.calls.length === 0, JSON.stringify(res));
	}

	// remove without force → refuses, never spawns
	{
		const run = fakeRunner();
		const res = await mod.runRemove(run, { name: "dev", force: false }, {});
		check("runRemove: refuses without force", res.ok === false && run.calls.length === 0, JSON.stringify(res));
	}
	// remove with force → deletes
	{
		const run = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res = await mod.runRemove(run, { name: "dev", force: true }, {});
		check(
			"runRemove: force deletes",
			res.ok === true && JSON.stringify(run.calls[0]) === JSON.stringify(["machine", "delete", "dev"]),
			JSON.stringify(res),
		);
	}

	// error normalization: spawnError → CLI-not-found guidance
	{
		const run = fakeRunner([{ ok: false, spawnError: "spawn container ENOENT" }]);
		const res = await mod.runList(run, {});
		check(
			"runList: spawnError → install guidance",
			res.ok === false && /brew install container/i.test(res.text),
			res.text,
		);
	}
}

async function scenarioBareActionSelector(url) {
	const mod = await loadModule(url);
	const makeCtx = ({ hasUI = true, selectResult } = {}) => {
		const selectCalls = [];
		return {
			ctx: {
				hasUI,
				ui: {
					select: async (title, items) => {
						selectCalls.push({ title, items });
						return selectResult;
					},
				},
			},
			selectCalls,
		};
	};

	// bare + UI → opens the action selector and returns the chosen action token
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "stop \u2014 stop a machine" });
		const out = await mod.resolveContainerInput("", ctx);
		check("bare + UI opens the action selector once", selectCalls.length === 1, `calls=${selectCalls.length}`);
		const items = selectCalls[0]?.items ?? [];
		const has = (v) => items.some((i) => String(i).toLowerCase().startsWith(v));
		check(
			"selector offers all six actions",
			["status", "list", "create", "run", "stop", "remove"].every(has),
			JSON.stringify(items),
		);
		check("returns the chosen action token", out === "stop", String(out));
	}

	// headless (no UI) → never opens the selector; passes the (empty) input through unchanged
	{
		const { ctx, selectCalls } = makeCtx({ hasUI: false, selectResult: "stop" });
		const out = await mod.resolveContainerInput("", ctx);
		check("headless bare never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
		check("headless bare passes through empty input", out === "", JSON.stringify(out));
	}

	// explicit argument → bypasses the selector entirely
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "stop" });
		const out = await mod.resolveContainerInput("list", ctx);
		check("explicit arg bypasses the selector", selectCalls.length === 0 && out === "list", String(out));
	}

	// cancelling the selector → empty string (runCommand then shows help), no crash
	{
		const { ctx } = makeCtx({ selectResult: undefined });
		const out = await mod.resolveContainerInput("", ctx);
		check("cancelling the selector yields empty input", out === "", JSON.stringify(out));
	}
}

async function scenarioRealSpawnMissingCli(url) {
	const mod = await loadModule(url);
	// REAL spawn of a guaranteed-absent binary → spawnError is real, message is bounded.
	const result = await mod.runContainer(["machine", "ls"], { bin: "container-does-not-exist-xyz", timeoutMs: 5000 });
	check("runContainer: missing bin → ok=false", result.ok === false, JSON.stringify(result));
	check(
		"runContainer: missing bin → spawnError set",
		typeof result.spawnError === "string" && result.spawnError.length > 0,
		JSON.stringify(result),
	);
}

async function main() {
	const { url } = await buildBundle();
	await scenarioRegistration(url);
	await scenarioPureHelpers(url);
	await scenarioArgBuilders(url);
	await scenarioHandlers(url);
	await scenarioBareActionSelector(url);
	await scenarioRealSpawnMissingCli(url);

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
