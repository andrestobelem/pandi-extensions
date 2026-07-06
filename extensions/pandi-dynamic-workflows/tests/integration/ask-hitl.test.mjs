/**
 * Tests de integración de comportamiento para la primitiva human-in-the-loop `ask()`.
 *
 * Un workflow corre en el Worker headless y llama ask(); el host puentea a un
 * ctx.ui CONTROLABLE (input/confirm/select) provisto por cada llamada tool.execute(), así cada
 * escenario scriptéa la respuesta humana e inspecciona qué recibió el diálogo ({ signal, timeout }).
 *
 *   input / confirm / select — ask maneja el diálogo ctx.ui correspondiente y devuelve la respuesta humana;
 *                              se escriben un evento `ask` + un journal record method:"ask".
 *   resume-replay (headline) — re-ejecutar un ask completado reproduce la respuesta journaled y NUNCA
 *                              llama la UI de nuevo (el ctx.ui de resume lanza si se toca).
 *   headless                 — hasUI:false devuelve options.default, o falla con un error claro que nombra el modo
 *                              cuando no se da default (nunca cuelga).
 *   race-cancellation        — race([ask, agent]) deja ganar al agente y CIERRA el diálogo ask vía
 *                              su signal por llamada; la rama ask nunca gana.
 *   timeout-passthrough      — options.timeoutMs llega al diálogo como opts.timeout.
 *
 * Corrélo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/ask-hitl.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const ASK_WORKFLOW = ["const answer = await ask(args.question, args.options);", "return { answer };"].join("\n");
const RACE_WORKFLOW = [
	"const result = await race([",
	"  (signal) => ask(args.question, { signal }),",
	"  (signal) => agent(args.winnerPrompt, { signal }),",
	"]);",
	"return result;",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-ask-hitl",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools };
}

// Un ctx cuyo ui input/confirm/select lo provee el caller (registra llamadas + últimos opts).
function makeCtx(cwd, { ui = {}, hasUI = true } = {}) {
	const baseUi = {
		theme: { fg: (_c, v) => v },
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async (_t, i = "") => i,
		custom: async () => undefined,
		getEditorComponent: () => undefined,
		setEditorComponent: () => {},
	};
	return {
		// Siempre print => el run ejecuta en FOREGROUND y devuelve su result (tui/rpc lo mandaría a background).
		// hasUI varía independientemente para ejercitar los paths ask() interactivo vs headless.
		mode: "print",
		hasUI,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: { ...baseUi, ...ui },
		sessionManager: { getEntries: () => [] },
	};
}

let tagSeq = 0;
async function makeRunner(url, workflowSrc, workflowName) {
	const tag = tagSeq++;
	const mod = await import(`${url}?i=${tag}`);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-ask-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", `${workflowName}.js`), `${workflowSrc}\n`, "utf8");
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const run = async (params, ctxOpts) => {
		const res = await tool.execute(
			"tc-ask",
			params,
			new AbortController().signal,
			undefined,
			makeCtx(project, ctxOpts),
		);
		return res?.details?.result;
	};
	return { run, project };
}

async function readJournalRecords(runDir, method) {
	const body = await fs.readFile(path.join(runDir, "journal.jsonl"), "utf8");
	const records = [];
	let parsedAll = true;
	for (const line of body.split("\n").filter((l) => l.trim())) {
		try {
			const rec = JSON.parse(line);
			if (!method || rec.method === method) records.push(rec);
		} catch {
			parsedAll = false;
		}
	}
	return { parsedAll, records };
}

// fake-pi: un agente [role:win-now] que emite y luego flushea antes de salir (usado por el escenario race).
async function writeFakePi(dir) {
	const fakePi = path.join(dir, "fake-pandi-ask.cjs");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "AGENT-WON" }] } }) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	return fakePi;
}

async function scenarioInput(url) {
	const { run } = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const calls = [];
	const result = await run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Capital of Spain?", options: { kind: "input" } },
			timeoutMs: 30_000,
		},
		{
			ui: {
				input: async (title, ph, opts) => {
					calls.push({ title, ph, opts });
					return "Madrid";
				},
			},
		},
	);
	check("input: run succeeds", result?.ok === true, result?.error);
	check("input: returns the typed answer", result?.output?.answer === "Madrid", JSON.stringify(result?.output));
	check(
		"input: ctx.ui.input was called once with the question",
		calls.length === 1 && calls[0].title?.includes("Capital"),
		JSON.stringify(calls.map((c) => c.title)),
	);
	if (result?.ok === true) {
		const { records } = await readJournalRecords(result.runDir, "ask");
		check(
			"input: a method:'ask' journal record was written",
			records.length === 1 && records[0]?.result?.answer === "Madrid",
			JSON.stringify(records.map((r) => r.result)),
		);
	}
}

async function scenarioConfirm(url) {
	const { run } = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const result = await run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Proceed?", options: { kind: "confirm" } },
			timeoutMs: 30_000,
		},
		{ ui: { confirm: async () => true } },
	);
	check(
		"confirm: returns the boolean answer",
		result?.ok === true && result?.output?.answer === true,
		JSON.stringify(result?.output),
	);
}

async function scenarioSelect(url) {
	const { run } = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const calls = [];
	const result = await run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Pick a color", options: { choices: ["red", "blue", "green"] } },
			timeoutMs: 30_000,
		},
		{
			ui: {
				select: async (title, options, opts) => {
					calls.push({ title, options, opts });
					return "blue";
				},
			},
		},
	);
	check(
		"select: returns the chosen option",
		result?.ok === true && result?.output?.answer === "blue",
		JSON.stringify(result?.output),
	);
	check(
		"select: ctx.ui.select received the choices",
		calls.length === 1 && Array.isArray(calls[0].options) && calls[0].options.includes("blue"),
		JSON.stringify(calls.map((c) => c.options)),
	);
}

async function scenarioResumeReplay(url) {
	const { run } = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const params = {
		action: "run",
		name: "ask-smoke",
		input: { question: "Capital of Spain?", options: { kind: "input" } },
		timeoutMs: 30_000,
	};
	const first = await run(params, { ui: { input: async () => "Madrid" } });
	check(
		"resume: first run answered Madrid",
		first?.ok === true && first?.output?.answer === "Madrid",
		JSON.stringify(first?.output),
	);
	if (first?.ok !== true) return;

	let resumeCalledUi = 0;
	const resumed = await run(
		{ action: "resume", name: first.runId, force: true, timeoutMs: 30_000 },
		{
			ui: {
				input: async () => {
					resumeCalledUi++;
					throw new Error("UI must NOT be called on resume");
				},
			},
		},
	);
	check("resume: resumed run succeeds", resumed?.ok === true, resumed?.error);
	check(
		"resume: replays the journaled answer (Madrid)",
		resumed?.output?.answer === "Madrid",
		JSON.stringify(resumed?.output),
	);
	check("resume: the UI was NEVER called on resume", resumeCalledUi === 0, `ui calls=${resumeCalledUi}`);
}

async function scenarioHeadless(url) {
	const withDefault = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const r1 = await withDefault.run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Capital?", options: { kind: "input", default: "fallback" } },
			timeoutMs: 30_000,
		},
		{ hasUI: false },
	);
	check(
		"headless: returns options.default when no UI",
		r1?.ok === true && r1?.output?.answer === "fallback",
		JSON.stringify(r1?.output),
	);

	const noDefault = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	// Un workflow que lanza falla el run; en modo foreground tool.execute puede LANZAR o devolver ok:false.
	let failMsg = null;
	try {
		const r2 = await noDefault.run(
			{
				action: "run",
				name: "ask-smoke",
				input: { question: "Capital?", options: { kind: "input" } },
				timeoutMs: 30_000,
			},
			{ hasUI: false },
		);
		if (r2?.ok === false) failMsg = String(r2?.error);
	} catch (e) {
		failMsg = String(e?.message ?? e);
	}
	check(
		"headless: fails with a clear error when no UI and no default",
		!!failMsg && /ask\(\)/.test(failMsg) && /UI|headless|human/i.test(failMsg),
		JSON.stringify(failMsg),
	);
}

// Corre un workflow que se espera que FALLE; devuelve el mensaje de falla (run lanza o devuelve ok:false).
async function runExpectFail(runner, params, ctxOpts) {
	try {
		const r = await runner.run(params, ctxOpts);
		return r?.ok === false ? String(r?.error) : null;
	} catch (e) {
		return String(e?.message ?? e);
	}
}

async function scenarioValidationGuards(url) {
	const ambiguous = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const m1 = await runExpectFail(
		ambiguous,
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Pick", options: { choices: ["a", "b"], default: false } },
			timeoutMs: 30_000,
		},
		{ ui: { select: async () => "a", confirm: async () => false } },
	);
	check(
		"guard: choices + boolean default without kind is rejected as ambiguous",
		!!m1 && /ambiguous/i.test(m1),
		JSON.stringify(m1),
	);

	const emptyChoices = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const m2 = await runExpectFail(
		emptyChoices,
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Pick", options: { kind: "select", choices: [] } },
			timeoutMs: 30_000,
		},
		{ ui: { select: async () => undefined } },
	);
	check(
		"guard: select with empty choices is rejected (no UI hang)",
		!!m2 && /non-empty|choices/i.test(m2),
		JSON.stringify(m2),
	);

	const badDefault = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const m3 = await runExpectFail(
		badDefault,
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Pick", options: { choices: ["a", "b"], default: "zzz" } },
			timeoutMs: 30_000,
		},
		{ hasUI: false },
	);
	check(
		"guard: headless select default not in choices is rejected (no garbage in journal)",
		!!m3 && /one of/i.test(m3),
		JSON.stringify(m3),
	);

	const goodDefault = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const r4 = await goodDefault.run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Pick", options: { choices: ["a", "b"], default: "b" } },
			timeoutMs: 30_000,
		},
		{ hasUI: false },
	);
	check(
		"guard: headless select with a valid default returns it",
		r4?.ok === true && r4?.output?.answer === "b",
		JSON.stringify(r4?.output),
	);
}

async function scenarioRaceCancellation(url) {
	const { run, project } = await makeRunner(url, RACE_WORKFLOW, "ask-race");
	const fakePi = await writeFakePi(project);
	let askSignalAborted = false;
	const old = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	let result;
	try {
		result = await run(
			{
				action: "run",
				name: "ask-race",
				input: { question: "Waiting…", winnerPrompt: "win please" },
				concurrency: 2,
				maxAgents: 3,
				timeoutMs: 30_000,
			},
			{
				ui: {
					// Colgá hasta que el signal por llamada aborte (el perdedor de la race), luego resolvé.
					input: async (_t, _ph, opts) =>
						await new Promise((resolve) => {
							opts?.signal?.addEventListener("abort", () => {
								askSignalAborted = true;
								resolve(undefined);
							});
						}),
				},
			},
		);
	} finally {
		if (old === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = old;
	}
	check("race-cancel: run succeeds", result?.ok === true, result?.error);
	check(
		"race-cancel: the agent branch wins (not ask)",
		result?.output?.winner === "AGENT-WON" && result?.output?.index === 1,
		JSON.stringify(result?.output),
	);
	check(
		"race-cancel: the ask dialog's signal was aborted (dismissed)",
		askSignalAborted === true,
		`aborted=${askSignalAborted}`,
	);
}

async function scenarioTimeoutPassthrough(url) {
	const { run } = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const calls = [];
	const result = await run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "Q?", options: { kind: "input", timeoutMs: 1234 } },
			timeoutMs: 30_000,
		},
		{
			ui: {
				input: async (_t, _ph, opts) => {
					calls.push(opts);
					return "x";
				},
			},
		},
	);
	check("timeout: run succeeds", result?.ok === true, result?.error);
	check(
		"timeout: options.timeoutMs reaches the dialog as opts.timeout",
		calls.length === 1 && calls[0]?.timeout === 1234,
		JSON.stringify(calls.map((c) => ({ timeout: c?.timeout }))),
	);
}

// Una respuesta secreta debe llegar al workflow pero NUNCA persistirse (events.jsonl/journal.jsonl)
// ni reproducirse en resume — si no, una API key recolectada vía ask() queda en plaintext en disco.
async function scenarioSecretRedaction(url) {
	const { run } = await makeRunner(url, ASK_WORKFLOW, "ask-smoke");
	const SENTINEL = "sk-LIVE-SECRET-123";
	const result = await run(
		{
			action: "run",
			name: "ask-smoke",
			input: { question: "API key?", options: { kind: "input", secret: true } },
			timeoutMs: 30_000,
		},
		{ ui: { input: async () => SENTINEL } },
	);
	check("secret: run succeeds", result?.ok === true, result?.error);
	check(
		"secret: the workflow still receives the real answer",
		result?.output?.answer === SENTINEL,
		JSON.stringify(result?.output),
	);
	if (result?.ok === true) {
		const events = await fs.readFile(path.join(result.runDir, "events.jsonl"), "utf8");
		check(
			"secret: the raw secret is NOT written to events.jsonl",
			!events.includes(SENTINEL),
			"sentinel leaked to events.jsonl",
		);
		let journal = "";
		try {
			journal = await fs.readFile(path.join(result.runDir, "journal.jsonl"), "utf8");
		} catch {}
		check(
			"secret: the raw secret is NOT written to journal.jsonl",
			!journal.includes(SENTINEL),
			"sentinel leaked to journal.jsonl",
		);
		check(
			"secret: no method:'ask' answer is journaled for replay (cache disabled)",
			!/"method":"ask"/.test(journal),
			"an ask journal record was written for a secret ask",
		);
	}
}

async function main() {
	const { url } = await buildExtension();
	await scenarioInput(url);
	await scenarioConfirm(url);
	await scenarioSelect(url);
	await scenarioResumeReplay(url);
	await scenarioHeadless(url);
	await scenarioValidationGuards(url);
	await scenarioRaceCancellation(url);
	await scenarioTimeoutPassthrough(url);
	await scenarioSecretRedaction(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err);
	process.exit(2);
});
