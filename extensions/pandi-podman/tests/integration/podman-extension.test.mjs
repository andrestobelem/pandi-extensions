#!/usr/bin/env node
/**
 * Contrato conductual de pandi-podman.
 *
 * Podman puede requerir una VM y su estado es global al host; la suite no crea
 * contenedores reales. Fija el contrato en helpers puros, argv exactos y
 * handlers con runner inyectado; solo el binario ausente/abort se prueba contra
 * procesos reales. Así CI no depende de Podman ni muta el host.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildBundle() {
	return await buildExtension({
		name: "pi-podman-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-podman", "index.ts"),
		outName: "podman.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		commands,
		tools,
	};
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

/** Runner inyectable: deja visible el argv sin requerir un daemon/VM de Podman. */
function fakeRunner(scripted = []) {
	const calls = [];
	let index = 0;
	const run = async (args, opts) => {
		calls.push({ args, opts });
		return typeof scripted === "function" ? scripted(args, opts) : (scripted[index++] ?? okResult());
	};
	run.calls = calls;
	return run;
}

function okResult(stdout = "") {
	return { ok: true, stdout, stderr: "", exitCode: 0 };
}

// Fixtures de las formas JSON que emite Podman 6.x con --format json.
const REAL_PS_JSON = JSON.stringify([
	{
		Id: "e6c2c6ee0b9ebc6f7cbfbd9761bc0d552be61fe5f6be1f7d55b13f06f1c99a01",
		Names: ["hello"],
		Image: "quay.io/podman/hello:latest",
		State: "running",
		Status: "Up 2 minutes",
		CreatedAt: "2026-07-10T10:00:00Z",
		Ports: [{ host_port: 0, container_port: 8080, protocol: "tcp" }],
	},
]);
const REAL_MACHINE_JSON = JSON.stringify([
	{
		Name: "podman-machine-default",
		Default: true,
		Running: true,
		CPUs: 6,
		Memory: "2147483648",
		DiskSize: "107374182400",
		VMType: "applehv",
	},
]);
const INFO_JSON = JSON.stringify({
	host: { arch: "arm64", security: { rootless: true, seccompEnabled: true } },
	store: { containerStore: { number: 1, running: 1, stopped: 0 }, imageStore: { number: 2 } },
	version: { Version: "6.0.1" },
});

async function scenarioRegistration(url) {
	const { commands, tools } = await loadExtension(url);
	check("registers /podman command", commands.has("podman"), [...commands.keys()].join(","));
	check("registers podman_sandbox tool", tools.has("podman_sandbox"), [...tools.keys()].join(","));
	const tool = tools.get("podman_sandbox");
	check("tool has execute()", typeof tool?.execute === "function");
	check("tool is sequential", tool?.executionMode === "sequential", String(tool?.executionMode));
}

async function scenarioPureContract(url) {
	const mod = await loadModule(url);
	const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

	for (const [name, valid] of [
		["web", true],
		["web_1.test", true],
		["", false],
		["-danger", false],
		["has space", false],
		["a/b", false],
	]) {
		check(
			`validateContainerName(${JSON.stringify(name)}) === ${valid}`,
			mod.validateContainerName(name) === valid,
			name,
		);
	}
	for (const [image, valid] of [
		["quay.io/podman/hello:latest", true],
		["localhost:5000/ns/app@sha256:abcdef", true],
		["", false],
		["-x", false],
		["has space", false],
	]) {
		check(
			`validateImageReference(${JSON.stringify(image)}) === ${valid}`,
			mod.validateImageReference(image) === valid,
			image,
		);
	}

	eq("buildInfoArgs", mod.buildInfoArgs(), ["info", "--format", "json"]);
	eq("buildListArgs", mod.buildListArgs(), ["ps", "--all", "--format", "json"]);
	eq("buildMachineListArgs", mod.buildMachineListArgs(), ["machine", "list", "--format", "json"]);
	eq("buildMachineStartArgs", mod.buildMachineStartArgs("dev"), ["machine", "start", "dev"]);
	eq("buildStopArgs", mod.buildStopArgs("web"), ["stop", "web"]);
	eq("buildRemoveArgs", mod.buildRemoveArgs("web"), ["rm", "--force", "web"]);
	eq(
		"buildRunArgs: default sandbox policy",
		mod.buildRunArgs({ image: "quay.io/podman/hello:latest", command: ["echo", "hello"], workdir: "/work" }),
		[
			"run",
			"--rm",
			"--network",
			"none",
			"--http-proxy=false",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"256",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,noexec",
			"--cpus",
			"2",
			"--memory",
			"1G",
			"--workdir",
			"/work",
			"quay.io/podman/hello:latest",
			"echo",
			"hello",
		],
	);
	eq(
		"buildRunArgs: network is opt-in and resources may tighten",
		mod.buildRunArgs({
			image: "quay.io/podman/hello:latest",
			command: ["id"],
			network: "default",
			cpus: 1,
			memory: "512M",
		}),
		[
			"run",
			"--rm",
			"--network",
			"default",
			"--http-proxy=false",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"256",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,noexec",
			"--cpus",
			"1",
			"--memory",
			"512M",
			"quay.io/podman/hello:latest",
			"id",
		],
	);

	const containers = mod.parseContainerList(REAL_PS_JSON);
	check("parseContainerList: one entry", containers.length === 1, JSON.stringify(containers));
	check(
		"parseContainerList: normalizes key fields",
		containers[0]?.id?.startsWith("e6c2") &&
			containers[0]?.name === "hello" &&
			containers[0]?.image === "quay.io/podman/hello:latest" &&
			containers[0]?.state === "running",
		JSON.stringify(containers[0]),
	);
	check("parseContainerList: invalid input is empty", mod.parseContainerList("not json").length === 0);
	check(
		"formatContainerList: concise output",
		/hello/.test(mod.formatContainerList(containers)),
		mod.formatContainerList(containers),
	);

	const machines = mod.parseMachineList(REAL_MACHINE_JSON);
	check("parseMachineList: one entry", machines.length === 1, JSON.stringify(machines));
	check(
		"parseMachineList: normalizes fields",
		machines[0]?.name === "podman-machine-default" &&
			machines[0]?.running === true &&
			machines[0]?.memory === 2147483648,
		JSON.stringify(machines[0]),
	);
	check("parseMachineList: invalid input is empty", mod.parseMachineList("not json").length === 0);

	const parsedInfo = mod.parseInfo(INFO_JSON);
	check(
		"parseInfo: exposes safe summary",
		parsedInfo.version === "6.0.1" && parsedInfo.rootless === true,
		JSON.stringify(parsedInfo),
	);

	const parsed = mod.parsePodmanCommand("run --network default quay.io/podman/hello:latest -- echo hello");
	check(
		"parsePodmanCommand: separates argv",
		parsed.action === "run" &&
			parsed.rest.join("|") === "--network|default|quay.io/podman/hello:latest" &&
			parsed.command.join("|") === "echo|hello",
		JSON.stringify(parsed),
	);
	const runOpts = mod.parseRunOptions(parsed.rest);
	check(
		"parseRunOptions: accepts only network default",
		runOpts.image === "quay.io/podman/hello:latest" && runOpts.network === "default" && !runOpts.error,
		JSON.stringify(runOpts),
	);
	check(
		"parseRunOptions: rejects unknown flags",
		/no admite/.test(mod.parseRunOptions(["--privileged", "alpine"]).error ?? ""),
	);
}

async function scenarioHandlers(url) {
	const mod = await loadModule(url);

	{
		const run = fakeRunner([okResult(INFO_JSON), okResult(REAL_MACHINE_JSON)]);
		const result = await mod.runStatus(run, { platform: "darwin" });
		check(
			"runStatus: combines info and machine state on macOS",
			result.ok && result.details.machines?.length === 1,
			result.text,
		);
		check(
			"runStatus: calls only read-only argv",
			JSON.stringify(run.calls.map(({ args }) => args)) ===
				JSON.stringify([mod.buildInfoArgs(), mod.buildMachineListArgs()]),
		);
	}
	{
		const run = fakeRunner([
			{ ok: false, stdout: "", stderr: "cannot connect", exitCode: 125 },
			okResult(REAL_MACHINE_JSON),
		]);
		const result = await mod.runStatus(run, { platform: "darwin" });
		check(
			"runStatus: reports a stopped/unavailable macOS machine",
			!result.ok && /machine-start/.test(result.text),
			result.text,
		);
	}
	{
		const run = fakeRunner([okResult(REAL_PS_JSON)]);
		const result = await mod.runList(run, {});
		check("runList: returns parsed containers", result.ok && result.details.count === 1, result.text);
	}
	{
		const run = fakeRunner();
		const result = await mod.runSandbox(run, { image: "", command: ["id"] }, {});
		check(
			"runSandbox: image required",
			!result.ok && /image/.test(result.text) && run.calls.length === 0,
			result.text,
		);
	}
	{
		const run = fakeRunner();
		const result = await mod.runSandbox(run, { image: "alpine", command: [], network: "none" }, {});
		check(
			"runSandbox: argv required",
			!result.ok && /command/.test(result.text) && run.calls.length === 0,
			result.text,
		);
	}
	{
		const run = fakeRunner([okResult("uid=1000\n")]);
		const result = await mod.runSandbox(run, { image: "alpine:latest", command: ["id"] }, {});
		check("runSandbox: stdout is preserved", result.ok && /uid=1000/.test(result.text), result.text);
		check(
			"runSandbox: applies constrained argv",
			JSON.stringify(run.calls[0]?.args) ===
				JSON.stringify(mod.buildRunArgs({ image: "alpine:latest", command: ["id"] })),
		);
	}
	{
		const run = fakeRunner();
		const result = await mod.runSandbox(
			run,
			{ image: "alpine:latest", command: ["id"], network: "host", workdir: "relative", cpus: 3, memory: "2G" },
			{},
		);
		check(
			"runSandbox: rejects attempts to loosen its policy before spawn",
			!result.ok && run.calls.length === 0,
			result.text,
		);
	}
	{
		const run = fakeRunner();
		const result = await mod.runRemove(run, { name: "web" }, {});
		check(
			"runRemove: refuses without force",
			!result.ok && result.details.needsForce === true && run.calls.length === 0,
			result.text,
		);
	}
	{
		const run = fakeRunner([okResult("web\n")]);
		const result = await mod.runRemove(run, { name: "web", force: true }, {});
		check(
			"runRemove: force reaches podman",
			result.ok && JSON.stringify(run.calls[0]?.args) === JSON.stringify(["rm", "--force", "web"]),
			result.text,
		);
	}
	{
		const run = fakeRunner([okResult("podman-machine-default\n")]);
		const result = await mod.runMachineStart(run, { name: "podman-machine-default" }, {});
		check(
			"runMachineStart: invokes a named machine",
			result.ok &&
				JSON.stringify(run.calls[0]?.args) === JSON.stringify(["machine", "start", "podman-machine-default"]),
			result.text,
		);
	}
}

async function scenarioRealRunner(url) {
	const mod = await loadModule(url);
	const absent = await mod.runPodman(["ps"], { bin: "podman-does-not-exist-xyz", timeoutMs: 1_000 });
	check(
		"runPodman: missing binary becomes a result",
		!absent.ok && /ENOENT/i.test(absent.spawnError ?? ""),
		JSON.stringify(absent),
	);

	const controller = new AbortController();
	const pending = mod.runPodman(["-e", "setTimeout(() => {}, 10_000)"], {
		bin: process.execPath,
		signal: controller.signal,
		timeoutMs: 5_000,
	});
	controller.abort();
	const aborted = await pending;
	check(
		"runPodman: abort becomes a timed-out result",
		!aborted.ok && aborted.timedOut === true,
		JSON.stringify(aborted),
	);
}

async function main() {
	const built = await buildBundle();
	await scenarioRegistration(built.url);
	await scenarioPureContract(built.url);
	await scenarioHandlers(built.url);
	await scenarioRealRunner(built.url);
	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) throw new Error(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
}

await main();
