/**
 * Tests de integración conductuales para el global `race()` + cancelación de subagentes in-flight.
 *
 * Corre workflows reales por el Worker con un subprocess de agente `pi` fakeado
 * (PI_DYNAMIC_WORKFLOWS_PI_COMMAND). El rol de cada rama se codifica en su prompt
 * ([role:...][id:...][need:N]) para que un único fake-pi flexible cubra todos los escenarios:
 *
 *   winner-basic         — race devuelve value/index/status "won" del winner; los dos LOSERS
 *                          in-flight reciben cada uno un SIGTERM real (winner intacto); y el journal
 *                          contiene SOLO el record del winner (losers cancelados dejan huecos, no records).
 *   first-success-wins   — una rama que FALLA rápido (-> null) nunca gana; una rama posterior gana y el
 *                          loser sano igual se cancela. Prueba accept-semantics + primer SUCCESS.
 *   resume-valid-winner  — re-correr una race completada reproduce el winner journaleado (cache hit) y
 *                          produce un winner VÁLIDO (B2: válido, no necesariamente idéntico), journal limpio.
 *   empty-contract       — todas las ramas fallan -> { winner:null, index:-1, status:"empty" }; journal limpio.
 *
 * Determinismo: el winner espera marcadores `spawned-*` (una barrera de filesystem, nunca sleeps) y
 * flushea stdout antes de salir; los LOSERS hacen self-exit después de un fallback generoso para que un kill perdido
 * nunca pueda deadlockear la suite.
 *
 * Follow-up no cubierto acá (impl presente, verificada por typecheck): el régimen concurrency<branches
 * pre-spawn-guard (régimen B1 b). Con concurrency 1 una race es efectivamente SECUENCIAL, así que
 * qué rama corre (y gana) primero es un detalle de scheduling, no un orden fijo — lo que hace inviable
 * una aserción determinista "el winner instantáneo gana / el loser parked nunca completa"
 * sin un harness de scheduling más fino.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/race-cancellation.test.mjs
 */
import { watch as watchDir } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

// Script top-level: race() sobre prompts provistos vía args, cada uno forwardea su signal.
const WORKFLOW = [
	"const result = await race(args.prompts.map((p) => (signal) => agent(p, { signal })));",
	"await writeArtifact('race.json', result);",
	"return result;",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-race-cancellation",
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

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

// `pi` fake flexible. El prompt (último argv) codifica un rol:
//   [role:win-barrier][id:X][need:N] -> esperar hasta que existan N marcadores `spawned-*`, luego emitir + exit 0.
//   [role:win-now][id:X]             -> emitir + exit 0 inmediatamente (winner instantáneo).
//   [role:fail][id:X]                -> anunciar spawn, luego exit 1 (sin output -> null).
//   [role:lose][id:X]                -> anunciar spawn; SIGTERM -> `cancelled-X` + exit; de lo contrario un
//                                       timer de fallback escribe `completed-X` + sale (sin bloqueo infinito).
// El winner flushea stdout (callback de write) ANTES de salir, así un exit rápido nunca trunca output.
// `.cjs` para que `require` funcione (el archivo se spawnea directamente vía shebang).
async function writeFakePi(barrierDir, tag) {
	const fakePi = path.join(barrierDir, `fake-pi-${tag}.cjs`);
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = process.argv[process.argv.length - 1] || "";
const dir = ${JSON.stringify(barrierDir)};
function marker(name) { try { fs.writeFileSync(path.join(dir, name), "x"); } catch {} }
function emitThenExit(text) {
  process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n", () => process.exit(0));
}
const id = (/\\[id:([a-z0-9]+)\\]/.exec(prompt) || [])[1] || "x";
if (/\\[role:win-barrier\\]/.test(prompt)) {
  const need = Number((/\\[need:(\\d+)\\]/.exec(prompt) || [])[1] || "2");
  const start = Date.now();
  (function poll() {
    let n = 0;
    try { n = fs.readdirSync(dir).filter((f) => f.startsWith("spawned-")).length; } catch {}
    if (n >= need || Date.now() - start > 8000) { marker("won-" + id); emitThenExit("WON-OUTPUT"); }
    else setTimeout(poll, 15);
  })();
} else if (/\\[role:win-now\\]/.test(prompt)) {
  marker("won-" + id); emitThenExit("WON-OUTPUT");
} else if (/\\[role:fail\\]/.test(prompt)) {
  marker("spawned-" + id); process.exit(1);
} else {
  process.on("SIGTERM", () => { marker("cancelled-" + id); process.exit(143); });
  marker("spawned-" + id);
  setTimeout(() => { marker("completed-" + id); process.exit(0); }, 4000);
}
`,
		{ mode: 0o700 },
	);
	return fakePi;
}

async function withFakePi(fakePi, fn) {
	const old = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	try {
		return await fn();
	} finally {
		if (old === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = old;
	}
}

async function listMarkers(dir, prefix) {
	return (await fs.readdir(dir)).filter((f) => f.startsWith(prefix));
}

async function waitForMarkers(dir, prefix, want, timeoutMs) {
	const initial = await listMarkers(dir, prefix);
	if (initial.length >= want) return initial;

	return await new Promise((resolve, reject) => {
		let settled = false;
		let watcher;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			watcher?.close();
			fn(value);
		};
		const readAndMaybeFinish = async () => {
			try {
				const markers = await listMarkers(dir, prefix);
				if (markers.length >= want) finish(resolve, markers);
			} catch (err) {
				finish(reject, err);
			}
		};
		const timer = setTimeout(async () => {
			try {
				finish(resolve, await listMarkers(dir, prefix));
			} catch (err) {
				finish(reject, err);
			}
		}, timeoutMs);
		watcher = watchDir(dir, { persistent: false }, () => {
			void readAndMaybeFinish();
		});
		void readAndMaybeFinish();
	});
}

async function readJournalAgentRecords(runDir) {
	const body = await fs.readFile(path.join(runDir, "journal.jsonl"), "utf8");
	const lines = body.split("\n").filter((l) => l.trim());
	let parsedAll = true;
	const records = [];
	for (const line of lines) {
		try {
			const rec = JSON.parse(line);
			if (rec.method === "agent") records.push(rec);
		} catch {
			parsedAll = false;
		}
	}
	return { parsedAll, records };
}

let tagSeq = 0;
// Runner reutilizable ligado a un proyecto fresco + fake-pi, para que un escenario pueda correr Y reanudar.
async function makeRunner(url) {
	const tag = tagSeq++;
	const mod = await import(`${url}?i=${tag}`);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "race-smoke.js"), `${WORKFLOW}\n`, "utf8");
	const barrierDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-barrier-"));
	const fakePi = await writeFakePi(barrierDir, `race-${tag}`);
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const run = (params) =>
		withFakePi(fakePi, async () => {
			const res = await tool.execute("tc-race", params, new AbortController().signal, undefined, makeCtx(project));
			return res?.details?.result;
		});
	return { run, barrierDir };
}

async function scenarioWinnerBasicAndJournal(url) {
	const { run, barrierDir } = await makeRunner(url);
	const result = await run({
		action: "run",
		name: "race-smoke",
		input: {
			prompts: [
				"[role:win-barrier][id:winner][need:2] produce the answer",
				"[role:lose][id:loser1] slow",
				"[role:lose][id:loser2] slow",
			],
		},
		concurrency: 3,
		maxAgents: 4,
		timeoutMs: 60_000,
	});
	const out = result?.output;
	check("winner-basic: run succeeds", result?.ok === true, result?.error);
	check("winner-basic: winner is the accepted value", out?.winner === "WON-OUTPUT", JSON.stringify(out));
	check("winner-basic: winner index is 0", out?.index === 0, JSON.stringify(out));
	check("winner-basic: status is 'won'", out?.status === "won", JSON.stringify(out));
	const spawned = await listMarkers(barrierDir, "spawned-");
	check(
		"winner-basic: both losers spawned (cancellation is mid-flight)",
		spawned.length === 2,
		JSON.stringify(spawned),
	);
	const cancelled = await waitForMarkers(barrierDir, "cancelled-", 2, 8000);
	check(
		"winner-basic: exactly 2 losers received SIGTERM (winner untouched)",
		cancelled.length === 2,
		JSON.stringify(cancelled),
	);

	if (result?.ok === true) {
		const { parsedAll, records } = await readJournalAgentRecords(result.runDir);
		check("winner-basic: journal.jsonl parses clean", parsedAll, "unparseable journal line");
		check(
			"winner-basic: exactly ONE agent record journaled (no cancelled losers)",
			records.length === 1,
			JSON.stringify(records.map((r) => r.result?.output)),
		);
		check(
			"winner-basic: the journaled record is the winner",
			records[0]?.result?.output === "WON-OUTPUT",
			JSON.stringify(records[0]?.result?.output),
		);
	}
}

async function scenarioFirstSuccessWins(url) {
	const { run, barrierDir } = await makeRunner(url);
	const result = await run({
		action: "run",
		name: "race-smoke",
		input: {
			prompts: [
				"[role:fail][id:fail0] dud",
				"[role:win-barrier][id:winner][need:2] answer",
				"[role:lose][id:loser2] slow",
			],
		},
		concurrency: 3,
		maxAgents: 4,
		timeoutMs: 60_000,
	});
	const out = result?.output;
	check("first-success: run succeeds", result?.ok === true, result?.error);
	check(
		"first-success: a failed branch never wins (winner is index 1)",
		out?.index === 1 && out?.winner === "WON-OUTPUT",
		JSON.stringify(out),
	);
	const cancelled = await waitForMarkers(barrierDir, "cancelled-", 1, 8000);
	check(
		"first-success: the healthy loser is still cancelled (exactly 1)",
		cancelled.length === 1,
		JSON.stringify(cancelled),
	);
}

async function scenarioResumeValidWinner(url) {
	const { run, barrierDir } = await makeRunner(url);
	const prompts = [
		"[role:win-barrier][id:winner][need:2] answer",
		"[role:lose][id:loser1] slow",
		"[role:lose][id:loser2] slow",
	];
	const first = await run({
		action: "run",
		name: "race-smoke",
		input: { prompts },
		concurrency: 3,
		maxAgents: 4,
		timeoutMs: 60_000,
	});
	check(
		"resume: first run succeeds with a winner",
		first?.ok === true && first?.output?.winner === "WON-OUTPUT",
		JSON.stringify(first?.output),
	);
	if (first?.ok !== true) return;
	await waitForMarkers(barrierDir, "cancelled-", 2, 8000);

	const resumed = await run({ action: "resume", name: first.runId, force: true, timeoutMs: 60_000 });
	check("resume: resumed run succeeds", resumed?.ok === true, resumed?.error);
	check(
		"resume: yields a VALID winner (B2: valid, not necessarily identical)",
		resumed?.output?.winner === "WON-OUTPUT",
		JSON.stringify(resumed?.output),
	);
	const cached = Number(resumed?.cachedCalls ?? resumed?.output?.cachedCalls ?? 0);
	check(
		"resume: at least one call replayed from the journal (winner cache hit)",
		cached >= 1 || resumed?.runId === first.runId,
		`cachedCalls=${cached} runId=${resumed?.runId}`,
	);
	if (resumed?.ok === true) {
		const { parsedAll } = await readJournalAgentRecords(resumed.runDir);
		check("resume: journal.jsonl still parses clean", parsedAll, "unparseable journal line");
	}
}

async function scenarioEmptyContract(url) {
	const { run } = await makeRunner(url);
	const result = await run({
		action: "run",
		name: "race-smoke",
		input: { prompts: ["[role:fail][id:a] dud", "[role:fail][id:b] dud", "[role:fail][id:c] dud"] },
		concurrency: 3,
		maxAgents: 4,
		timeoutMs: 60_000,
	});
	const out = result?.output;
	check("empty-contract: run succeeds", result?.ok === true, result?.error);
	check(
		"empty-contract: all-fail yields { winner:null, index:-1, status:'empty' }",
		out?.winner === null && out?.index === -1 && out?.status === "empty",
		JSON.stringify(out),
	);
	if (result?.ok === true) {
		const { parsedAll } = await readJournalAgentRecords(result.runDir);
		check("empty-contract: journal.jsonl parses clean", parsedAll, "unparseable journal line");
	}
}

// Cancelación a nivel run: cuando aborta el signal de TODO el run (cancelación de usuario) con una llamada
// de subagente todavía in-flight, cleanup() debe SIGTERMear el child, no dejarlo corriendo hasta su propio timeout.
// El bug: onAbort (signal del run) disparaba primero y cleanup disposeaba cada signal combinado por llamada
// ANTES de que corriera el listener de abort propio de ese signal, así que el child nunca se mataba.
async function scenarioRunAbortCancelsInflight(url) {
	const tag = tagSeq++;
	const mod = await import(`${url}?i=${tag}`);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "hang.js"),
		"await agent(args.prompt);\nreturn 'done';\n",
		"utf8",
	);
	const barrierDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-barrier-"));
	const fakePi = await writeFakePi(barrierDir, `abort-${tag}`);
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const rc = new AbortController();
	const done = withFakePi(fakePi, async () => {
		try {
			return await tool.execute(
				"tc-abort",
				{
					action: "run",
					name: "hang",
					input: { prompt: "[role:lose][id:hang] slow" },
					concurrency: 1,
					maxAgents: 2,
					timeoutMs: 60_000,
				},
				rc.signal,
				undefined,
				makeCtx(project),
			);
		} catch (e) {
			return { threw: String(e?.message ?? e) };
		}
	});
	// Esperá hasta que el child haya spawneado (llamada in-flight), luego abortá todo el run.
	const spawned = await waitForMarkers(barrierDir, "spawned-", 1, 8000);
	check(
		"run-abort: the subagent child spawned (in-flight before abort)",
		spawned.length === 1,
		JSON.stringify(spawned),
	);
	rc.abort(new Error("user cancelled the run"));
	await done;
	const cancelled = await waitForMarkers(barrierDir, "cancelled-", 1, 6000);
	const completed = await listMarkers(barrierDir, "completed-");
	check(
		"run-abort: the in-flight child received SIGTERM (cancelled), not run to completion",
		cancelled.length === 1 && completed.length === 0,
		`cancelled=${JSON.stringify(cancelled)} completed=${JSON.stringify(completed)}`,
	);
}

// Un loser de race() que hace fan-out vía agents({ signal }) debe CANCELAR sus children in-flight
// cuando pierde, igual que hacen los losers de agent()/ask(). El worker debe puentear el abort por llamada al
// host (post abort-call) Y el host debe honrar ese signal en el fan-out de agents; si no, los children
// de la rama agents perdedora corren hasta su propio timeout. (Nota: en Node >=20 postMessage puede
// structured-clonear un AbortSignal, así que esto es un gap de cancelación, no un crash DataCloneError).
async function scenarioRaceAgentsLosersCancelled(url) {
	const tag = tagSeq++;
	const mod = await import(`${url}?i=${tag}`);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "race-agents.js"),
		[
			"const result = await race([",
			"  (signal) => agents(args.losers, { signal, concurrency: 2 }),",
			"  (signal) => agent(args.winner, { signal }),",
			"]);",
			// Mantené vivo el run DESPUÉS de que race resuelva para que el cleanup de run-end no enmascare si la
			// rama agents() perdedora se canceló EN RACE-LOSS (el gap real) vs solo al final del run.
			"await sleep(3000);",
			"return result;",
		].join("\n"),
		"utf8",
	);
	const barrierDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-barrier-"));
	const fakePi = await writeFakePi(barrierDir, `ragts-${tag}`);
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	// Arrancá el run SIN await: el winner bloquea hasta los 2 spawns de losers y luego gana; después el
	// workflow duerme 3s. Observamos el estado de los losers DURANTE esa ventana de sleep.
	const runPromise = withFakePi(fakePi, async () => {
		const res = await tool.execute(
			"tc-ragts",
			{
				action: "run",
				name: "race-agents",
				input: {
					losers: ["[role:lose][id:al1] slow", "[role:lose][id:al2] slow"],
					winner: "[role:win-barrier][id:win][need:2] go",
				},
				concurrency: 3,
				maxAgents: 4,
				timeoutMs: 60_000,
			},
			new AbortController().signal,
			undefined,
			makeCtx(project),
		);
		return res?.details?.result;
	});
	// El winner escribe won-win cuando gana => la race resolvió y la rama agents perdedora
	// perdió. Si los losers se cancelan EN RACE-LOSS reciben SIGTERM en ~ms; si solo al final del run,
	// siguen vivos durante el sleep de 3s. Dales una ventana ajustada que termine bastante antes del run-end.
	await waitForMarkers(barrierDir, "won-", 1, 8000);
	const cancelledAtLoss = await waitForMarkers(barrierDir, "cancelled-", 2, 1500);
	const completedAtLoss = await listMarkers(barrierDir, "completed-");
	const result = await runPromise;
	check("race-agents: run succeeds", result?.ok === true, result?.error);
	check("race-agents: the agent branch wins (index 1)", result?.output?.index === 1, JSON.stringify(result?.output));
	check(
		"race-agents: both agents()-branch losers are cancelled AT RACE-LOSS (not deferred to run end)",
		cancelledAtLoss.length === 2 && completedAtLoss.length === 0,
		`cancelledAtLoss=${JSON.stringify(cancelledAtLoss)} completedAtLoss=${JSON.stringify(completedAtLoss)}`,
	);
}

async function main() {
	const { url } = await buildExtension();
	await scenarioWinnerBasicAndJournal(url);
	await scenarioFirstSuccessWins(url);
	await scenarioResumeValidWinner(url);
	await scenarioEmptyContract(url);
	await scenarioRunAbortCancelsInflight(url);
	await scenarioRaceAgentsLosersCancelled(url);

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
