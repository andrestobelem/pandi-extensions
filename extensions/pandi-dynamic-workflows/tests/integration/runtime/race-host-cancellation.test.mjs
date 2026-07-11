/**
 * Regresión para llamadas host cancelables dentro de race().
 *
 * El winner mantiene viva la corrida después de resolver la carrera. Así distinguimos la
 * cancelación inmediata de la rama perdedora del cleanup tardío al finalizar el run.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_color, value) => value },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

function makePi(exec) {
	const tools = new Map();
	const pi = {
		registerTool: (definition) => tools.set(definition.name, definition),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec,
	};
	return { pi, tools };
}

async function scenarioRaceCancelsBashLoser(url) {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-host-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "race-bash.js"),
		[
			"const result = await race([",
			'  (signal) => bash("blocked-command", { signal }),',
			'  () => sleep(20).then(() => "winner"),',
			"]);",
			"await sleep(500);",
			"return result;",
		].join("\n"),
		"utf8",
	);

	let notifyExecStarted;
	const execStarted = new Promise((resolve) => {
		notifyExecStarted = resolve;
	});
	let notifyBashAborted;
	const bashAborted = new Promise((resolve) => {
		notifyBashAborted = resolve;
	});
	const exec = async (_command, _args, options = {}) =>
		await new Promise((resolve) => {
			notifyExecStarted();
			const fallback = setTimeout(() => resolve({ code: 0, killed: false, stdout: "late", stderr: "" }), 1000);
			options.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(fallback);
					notifyBashAborted();
					resolve({ code: 143, killed: true, stdout: "", stderr: "cancelled" });
				},
				{ once: true },
			);
		});

	const mod = await import(`${url}?race-host-bash`);
	const { pi, tools } = makePi(exec);
	(mod.default.activate ?? mod.default)(pi, makeCtx(project));
	const runPromise = tools.get("dynamic_workflow").execute(
		"tc-race-host-bash",
		{
			action: "run",
			name: "race-bash",
			concurrency: 2,
			maxAgents: 2,
			timeoutMs: 10_000,
		},
		new AbortController().signal,
		undefined,
		makeCtx(project),
	);

	await execStarted;
	const cancelledBeforeRunEnd = await Promise.race([
		bashAborted.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 250)),
	]);
	check(
		"race bash: losing command is aborted before the workflow reaches run-end cleanup",
		cancelledBeforeRunEnd === true,
	);
	const response = await runPromise;
	const result = response?.details?.result;
	check("race bash: run succeeds", result?.ok === true, result?.error);
	check(
		"race bash: sleep branch remains the winner",
		result?.output?.status === "won" && result?.output?.winner === "winner" && result?.output?.index === 1,
		JSON.stringify(result?.output),
	);
}

async function scenarioImmediateWinnerSkipsBashSpawn(url) {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-host-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "race-bash-immediate.js"),
		[
			"const result = await race([",
			'  (signal) => bash("must-not-start", { signal }),',
			'  () => "winner",',
			"]);",
			"await sleep(50);",
			"return result;",
		].join("\n"),
		"utf8",
	);

	let execCalls = 0;
	const mod = await import(`${url}?race-host-bash-immediate`);
	const { pi, tools } = makePi(async () => {
		execCalls++;
		return { code: 0, killed: false, stdout: "unexpected", stderr: "" };
	});
	(mod.default.activate ?? mod.default)(pi, makeCtx(project));
	const response = await tools.get("dynamic_workflow").execute(
		"tc-race-host-bash-immediate",
		{
			action: "run",
			name: "race-bash-immediate",
			concurrency: 2,
			maxAgents: 2,
			timeoutMs: 10_000,
		},
		new AbortController().signal,
		undefined,
		makeCtx(project),
	);
	const result = response?.details?.result;
	check("race bash: immediate winner keeps the run successful", result?.ok === true, result?.error);
	check(
		"race bash: a branch aborted during start logging never spawns its command",
		execCalls === 0,
		`exec calls: ${execCalls}`,
	);
}

async function scenarioRaceCancelsSleepLoser(url) {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-host-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "race-sleep.js"),
		[
			'let loserState = "pending";',
			"const result = await race([",
			"  async (signal) => {",
			"    try {",
			"      await sleep(750, { signal });",
			'      loserState = "completed";',
			'      return "late";',
			"    } catch {",
			'      loserState = "cancelled";',
			"      return null;",
			"    }",
			"  },",
			'  () => sleep(20).then(() => "winner"),',
			"]);",
			"await sleep(100);",
			"return { result, loserState };",
		].join("\n"),
		"utf8",
	);

	const mod = await import(`${url}?race-host-sleep`);
	const { pi, tools } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
	(mod.default.activate ?? mod.default)(pi, makeCtx(project));
	const response = await tools.get("dynamic_workflow").execute(
		"tc-race-host-sleep",
		{
			action: "run",
			name: "race-sleep",
			concurrency: 2,
			maxAgents: 2,
			timeoutMs: 10_000,
		},
		new AbortController().signal,
		undefined,
		makeCtx(project),
	);
	const result = response?.details?.result;
	check("race sleep: run succeeds", result?.ok === true, result?.error);
	check(
		"race sleep: fast branch remains the winner",
		result?.output?.result?.status === "won" &&
			result?.output?.result?.winner === "winner" &&
			result?.output?.result?.index === 1,
		JSON.stringify(result?.output),
	);
	check(
		"race sleep: losing delay rejects before run-end cleanup",
		result?.output?.loserState === "cancelled",
		JSON.stringify(result?.output),
	);
}

async function scenarioLegacyContextBridgesBranchSignals(url) {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-host-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "race-ctx.js"),
		[
			"export default async function main(ctx) {",
			'  let loserState = "pending";',
			"  const bashResult = await ctx.race([",
			'    (signal) => ctx.bash("blocked-context-command", { signal }),',
			'    () => ctx.sleep(20).then(() => "winner"),',
			"  ]);",
			"  const sleepResult = await ctx.race([",
			"    async (signal) => {",
			"      try {",
			"        await ctx.sleep(750, { signal });",
			'        loserState = "completed";',
			"      } catch {",
			'        loserState = "cancelled";',
			"      }",
			"      return null;",
			"    },",
			'    () => ctx.sleep(20).then(() => "winner"),',
			"  ]);",
			"  await ctx.sleep(500);",
			"  return { bashResult, sleepResult, loserState };",
			"}",
		].join("\n"),
		"utf8",
	);

	let execCalls = 0;
	let bashAborted = false;
	let notifyExecStarted;
	const execStarted = new Promise((resolve) => {
		notifyExecStarted = resolve;
	});
	let notifyBashAborted;
	const bashAbortObserved = new Promise((resolve) => {
		notifyBashAborted = resolve;
	});
	const exec = async (_command, _args, options = {}) =>
		await new Promise((resolve) => {
			execCalls++;
			notifyExecStarted();
			const fallback = setTimeout(() => resolve({ code: 0, killed: false, stdout: "late", stderr: "" }), 1000);
			options.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(fallback);
					bashAborted = true;
					notifyBashAborted();
					resolve({ code: 143, killed: true, stdout: "", stderr: "cancelled" });
				},
				{ once: true },
			);
		});
	const mod = await import(`${url}?race-host-ctx`);
	const { pi, tools } = makePi(exec);
	(mod.default.activate ?? mod.default)(pi, makeCtx(project));
	const runPromise = tools.get("dynamic_workflow").execute(
		"tc-race-host-ctx",
		{
			action: "run",
			name: "race-ctx",
			concurrency: 2,
			maxAgents: 2,
			timeoutMs: 10_000,
		},
		new AbortController().signal,
		undefined,
		makeCtx(project),
	);
	await execStarted;
	const cancelledBeforeRunEnd = await Promise.race([
		bashAbortObserved.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 250)),
	]);
	check("race ctx: bash signal aborts before legacy context run-end cleanup", cancelledBeforeRunEnd === true);
	const response = await runPromise;
	const result = response?.details?.result;
	check("race ctx: legacy context workflow succeeds", result?.ok === true, result?.error);
	check(
		"race ctx: bash signal crosses the legacy context bridge",
		execCalls === 1 && bashAborted === true,
		JSON.stringify({ execCalls, bashAborted }),
	);
	check(
		"race ctx: sleep signal crosses the legacy context bridge",
		result?.output?.loserState === "cancelled",
		JSON.stringify(result?.output),
	);
}

async function main() {
	const { url } = await buildDwfExtension({ name: "pi-dw-race-host-cancellation" });
	await scenarioRaceCancelsBashLoser(url);
	await scenarioImmediateWinnerSkipsBashSpawn(url);
	await scenarioRaceCancelsSleepLoser(url);
	await scenarioLegacyContextBridgesBranchSignals(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((failure) => `- ${failure}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exit(2);
});
