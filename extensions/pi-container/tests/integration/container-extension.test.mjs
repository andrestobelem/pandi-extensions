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
 *
 * P4 additions (issue #3, mutation-verified non-vacuous): runStatus not-booted /
 * running / degraded-ls branches, create/stop/exec validation + describeError
 * normalization (stderr detail, exit-code fallback, timed-out), parseContainerCommand,
 * REAL runContainer timeout + abort, and outside-in command/tool paths — each platform
 * pins its real branch (linux CI: the platform guard; macOS/arm64: help/unknown/remove
 * gates, including confirmed-remove threading force:true to the CLI, kept harmless via
 * a guaranteed-absent machine name).
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

// runStatus branches (issue #3 "not booted"): a failing `system status` must surface
// the CLI detail; a running subsystem lists machines; a failing machine-ls degrades
// to an empty list instead of failing the whole status.
async function scenarioStatusHandler(url) {
	const mod = await loadModule(url);

	{
		const run = fakeRunner([
			{
				ok: false,
				stdout: "",
				stderr: "apiserver is not running; start with `container system start`",
				exitCode: 1,
			},
		]);
		const res = await mod.runStatus(run, {});
		check("runStatus not booted: ok=false", res.ok === false, JSON.stringify(res));
		check("runStatus not booted: surfaces the CLI detail", /apiserver is not running/.test(res.text), res.text);
		check("runStatus not booted: no machine-ls after the failure", run.calls.length === 1, String(run.calls.length));
	}

	{
		const run = fakeRunner([
			{ ok: true, stdout: "{}", stderr: "", exitCode: 0 },
			{ ok: true, stdout: REAL_MACHINE_JSON, stderr: "", exitCode: 0 },
		]);
		const res = await mod.runStatus(run, {});
		check("runStatus running: ok + machine listed", res.ok === true && /dev/.test(res.text), res.text);
	}

	{
		const run = fakeRunner([
			{ ok: true, stdout: "{}", stderr: "", exitCode: 0 },
			{ ok: false, stdout: "", stderr: "boom", exitCode: 1 },
		]);
		const res = await mod.runStatus(run, {});
		check(
			"runStatus with failing ls: still ok, empty machine list",
			res.ok === true && /No container machines/.test(res.text),
			res.text,
		);
	}
}

// create/stop/exec error edges (issue #3 "run failure"): argument validation refuses
// BEFORE spawning; CLI failures normalize through describeError (stderr detail,
// exit-code fallback, timed-out).
async function scenarioHandlerErrorEdges(url) {
	const mod = await loadModule(url);

	// create: missing image / invalid name → refused, no spawn
	{
		const run = fakeRunner();
		const res = await mod.runCreate(run, { image: "" }, {});
		check("runCreate: missing image refused, no spawn", res.ok === false && run.calls.length === 0, res.text);
		const res2 = await mod.runCreate(run, { image: "alpine:latest", name: "bad name" }, {});
		check("runCreate: invalid name refused, no spawn", res2.ok === false && run.calls.length === 0, res2.text);
	}
	// create: CLI failure → normalized error; success → confirmation text
	{
		const run = fakeRunner([{ ok: false, stdout: "", stderr: "kernel not configured", exitCode: 1 }]);
		const res = await mod.runCreate(run, { image: "alpine:latest", name: "dev" }, {});
		check(
			"runCreate: CLI failure carries stderr detail",
			res.ok === false && /kernel not configured/.test(res.text),
			res.text,
		);
		const run2 = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res2 = await mod.runCreate(run2, { image: "alpine:latest", name: "dev" }, {});
		check(
			"runCreate: success confirms machine + image",
			res2.ok === true && /dev.*alpine:latest/.test(res2.text),
			res2.text,
		);
	}

	// stop: invalid name refused; empty-output failure falls back to the exit code; default name
	{
		const run = fakeRunner();
		const res = await mod.runStop(run, { name: "a;b" }, {});
		check("runStop: invalid name refused, no spawn", res.ok === false && run.calls.length === 0, res.text);
		const run2 = fakeRunner([{ ok: false, stdout: "", stderr: "", exitCode: 7 }]);
		const res2 = await mod.runStop(run2, { name: "dev" }, {});
		check(
			"runStop: empty-detail failure reports the exit code",
			res2.ok === false && /exit 7/.test(res2.text),
			res2.text,
		);
		const run3 = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res3 = await mod.runStop(run3, {}, {});
		check("runStop: no name stops the default machine", res3.ok === true && /\(default\)/.test(res3.text), res3.text);
	}

	// exec: invalid machine name refused before spawning; empty stdout → explicit marker; timeout → timed-out text
	{
		const run = fakeRunner();
		const res = await mod.runExec(run, { machine: "a b", command: ["true"] }, {});
		check("runExec: invalid machine name refused, no spawn", res.ok === false && run.calls.length === 0, res.text);
		const run2 = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res2 = await mod.runExec(run2, { machine: "dev", command: ["true"] }, {});
		check("runExec: empty stdout reports '(no output)'", res2.ok === true && /no output/i.test(res2.text), res2.text);
		const run3 = fakeRunner([{ ok: false, stdout: "", stderr: "", timedOut: true }]);
		const res3 = await mod.runExec(run3, { machine: "dev", command: ["sleep", "99"] }, {});
		check("runExec: timeout normalizes to 'timed out'", res3.ok === false && /timed out/i.test(res3.text), res3.text);
	}
}

// parseContainerCommand (pure): `--` argv separator, defaults, case-insensitivity.
async function scenarioParseContainerCommand(url) {
	const mod = await loadModule(url);
	const p = mod.parseContainerCommand;

	const full = p("run dev -- echo hi there");
	check(
		"parse: '--' splits argv command",
		full.action === "run" && full.rest[0] === "dev" && JSON.stringify(full.command) === '["echo","hi","there"]',
		JSON.stringify(full),
	);
	check("parse: empty input defaults to status", p("").action === "status", JSON.stringify(p("")));
	check("parse: action is lowercased", p("LIST").action === "list", JSON.stringify(p("LIST")));
	check(
		"parse: no '--' means empty command",
		p("stop dev").command.length === 0 && p("stop dev").rest[0] === "dev",
		JSON.stringify(p("stop dev")),
	);
}

// runContainer real process edges: a hung child is SIGTERM'd at timeoutMs (timedOut,
// ok=false), and an abort signal kills it the same way — real spawns, not mocks.
async function scenarioRealTimeoutAndAbort(url) {
	const mod = await loadModule(url);

	const hung = await mod.runContainer(["-e", "setTimeout(() => {}, 10000)"], {
		bin: process.execPath,
		timeoutMs: 300,
	});
	check(
		"runContainer: timeout → ok=false + timedOut",
		hung.ok === false && hung.timedOut === true,
		JSON.stringify(hung),
	);

	const controller = new AbortController();
	const pending = mod.runContainer(["-e", "setTimeout(() => {}, 10000)"], {
		bin: process.execPath,
		signal: controller.signal,
		timeoutMs: 30000,
	});
	setTimeout(() => controller.abort(), 100);
	const aborted = await pending;
	check(
		"runContainer: abort → ok=false + timedOut flag",
		aborted.ok === false && aborted.timedOut === true,
		JSON.stringify(aborted),
	);
}

// Outside-in (issue #3): drive the REAL /container command handler and the
// container_sandbox tool. The runner is not injectable at this level, so only
// no-spawn paths are pinned — and each platform pins its real branch: on
// unsupported hosts (linux CI) every call must short-circuit with the platform
// message; on macOS/arm64 the help/unknown/remove-gate paths run (none spawns).
async function scenarioCommandAndToolOutsideIn(url) {
	const mod = await loadModule(url);
	const { commands, tools } = await loadExtension(url);
	const command = commands.get("container");
	const tool = tools.get("container_sandbox");

	const makeCtx = ({ hasUI = true, confirmResult = false } = {}) => {
		const notes = [];
		const confirms = [];
		const ctx = {
			mode: "tui",
			hasUI,
			cwd: REPO_ROOT,
			ui: {
				notify: (msg, type) => notes.push({ msg, type }),
				confirm: async (title, message) => {
					confirms.push({ title, message });
					return confirmResult;
				},
				select: async () => undefined,
			},
		};
		return { ctx, notes, confirms };
	};

	if (!mod.isSupportedPlatform()) {
		// Unsupported host (linux CI): the guard must fire for BOTH surfaces, before any spawn.
		const { ctx, notes } = makeCtx();
		await command.handler("status", ctx);
		check(
			"unsupported host: /container reports the platform requirement",
			notes.some((n) => n.type === "error" && /Apple Silicon/i.test(n.msg)),
			JSON.stringify(notes),
		);
		const res = await tool.execute("t1", { action: "status" }, undefined, undefined, ctx);
		check(
			"unsupported host: tool reports the platform requirement",
			res.details?.isError === true && /Apple Silicon/i.test(res.content[0]?.text ?? ""),
			JSON.stringify(res),
		);
		return;
	}

	// Supported host (macOS/arm64): pin the no-spawn command paths.
	{
		const { ctx, notes } = makeCtx();
		await command.handler("help", ctx);
		check(
			"/container help prints usage",
			notes.some((n) => n.type === "info" && /Usage:/.test(n.msg)),
			JSON.stringify(notes.map((n) => n.type)),
		);
	}
	{
		const { ctx, notes } = makeCtx();
		await command.handler("frobnicate", ctx);
		check(
			"/container unknown subcommand warns + shows usage",
			notes.some(
				(n) => n.type === "warning" && /Unknown subcommand: frobnicate/.test(n.msg) && /Usage:/.test(n.msg),
			),
			JSON.stringify(notes.map((n) => n.type)),
		);
	}
	{
		// remove via the command: declining the confirm must refuse WITHOUT spawning.
		const { ctx, notes, confirms } = makeCtx({ confirmResult: false });
		await command.handler("remove dev", ctx);
		check("/container remove asks for confirmation", confirms.length === 1, `confirms=${confirms.length}`);
		check(
			"/container remove declined → refuses (needs force)",
			notes.some((n) => n.type === "error" && /Refusing to delete/i.test(n.msg)),
			JSON.stringify(notes),
		);
	}
	{
		// headless remove: no UI to confirm → force stays false → refuses, no spawn.
		const { ctx, notes, confirms } = makeCtx({ hasUI: false });
		ctx.mode = "print";
		const errs = [];
		const origErr = console.error;
		console.error = (m) => errs.push(String(m));
		try {
			await command.handler("remove dev", ctx);
		} finally {
			console.error = origErr;
		}
		check("headless remove: never confirms", confirms.length === 0, `confirms=${confirms.length}`);
		check(
			"headless remove: refuses on stderr",
			errs.some((m) => /Refusing to delete/i.test(m)),
			JSON.stringify({ errs, notes }),
		);
	}
	{
		// remove CONFIRMED: the confirm result must thread through as force:true, so the
		// request reaches the CLI instead of the needsForce gate. A valid-shaped but
		// guaranteed-absent machine keeps this harmless: the CLI errors (machine not
		// found / not installed / not booted) — anything BUT the "Refusing" refusal.
		const { ctx, notes, confirms } = makeCtx({ confirmResult: true });
		await command.handler("remove pi-test-absent-machine-xyz", ctx);
		check("/container remove confirmed: confirm was asked", confirms.length === 1, `confirms=${confirms.length}`);
		check(
			"/container remove confirmed: force threads through (no needsForce refusal)",
			notes.length > 0 && !notes.some((n) => /Refusing to delete/i.test(n.msg)),
			JSON.stringify(notes),
		);
	}
	{
		// Tool surface, no-spawn paths: remove without force refuses; defensive unknown action.
		const { ctx } = makeCtx();
		const refused = await tool.execute("t2", { action: "remove", name: "dev" }, undefined, undefined, ctx);
		check(
			"tool remove without force refuses (needsForce)",
			refused.details?.isError === true && refused.details?.needsForce === true,
			JSON.stringify(refused.details),
		);
		const bogus = await tool.execute("t3", { action: "bogus" }, undefined, undefined, ctx);
		check(
			"tool unknown action → bounded error result",
			bogus.details?.isError === true && /Unknown action/.test(bogus.content[0]?.text ?? ""),
			JSON.stringify(bogus),
		);
	}
}

async function main() {
	const { url } = await buildBundle();
	await scenarioRegistration(url);
	await scenarioPureHelpers(url);
	await scenarioArgBuilders(url);
	await scenarioHandlers(url);
	await scenarioBareActionSelector(url);
	await scenarioRealSpawnMissingCli(url);
	await scenarioStatusHandler(url);
	await scenarioHandlerErrorEdges(url);
	await scenarioParseContainerCommand(url);
	await scenarioRealTimeoutAndAbort(url);
	await scenarioCommandAndToolOutsideIn(url);

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
