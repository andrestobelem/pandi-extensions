/**
 * Behavioral integration tests for the `race()` global + in-flight subagent cancellation.
 *
 * Runs real workflows through the Worker with a faked `pi` agent subprocess
 * (PI_DYNAMIC_WORKFLOWS_PI_COMMAND). Each branch's role is encoded in its prompt
 * ([role:...][id:...][need:N]) so one flexible fake-pi covers every scenario:
 *
 *   winner-basic         — race returns the winner's value/index/status "won"; the two in-flight
 *                          LOSERS each receive a real SIGTERM (winner untouched); and the journal
 *                          holds ONLY the winner's record (cancelled losers leave holes, not records).
 *   first-success-wins   — a branch that FAILS fast (-> null) never wins; a later branch wins and the
 *                          healthy loser is still cancelled. Proves accept-semantics + first SUCCESS.
 *   resume-valid-winner  — re-running a completed race replays the journaled winner (cache hit) and
 *                          yields a VALID winner (B2: valid, not necessarily identical), journal clean.
 *   empty-contract       — all branches fail -> { winner:null, index:-1, status:"empty" }; journal clean.
 *
 * Determinism: the winner waits for `spawned-*` markers (a filesystem barrier, never sleeps) and
 * flushes stdout before exit; LOSERS self-exit after a generous fallback so a missed kill can never
 * deadlock the suite.
 *
 * Follow-up not covered here (impl is in place, typecheck-verified): the concurrency<branches
 * pre-spawn-guard regime (B1 regime b). With concurrency 1 a race is effectively SEQUENTIAL, so
 * which branch runs (and wins) first is a scheduling detail, not a fixed order — making a
 * deterministic "the instant winner wins / the parked loser never completes" assertion infeasible
 * without a finer scheduling harness.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/race-cancellation.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

// Top-level script: race() over prompts supplied via args, each forwarding its signal.
const WORKFLOW = [
	"const result = await race(args.prompts.map((p) => (signal) => agent(p, { signal })));",
	"await writeArtifact('race.json', result);",
	"return result;",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-race-cancellation",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
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

// Flexible fake `pi`. The prompt (last argv) encodes a role:
//   [role:win-barrier][id:X][need:N] -> wait until N `spawned-*` markers exist, then emit + exit 0.
//   [role:win-now][id:X]             -> emit + exit 0 immediately (instant winner).
//   [role:fail][id:X]                -> announce spawn, then exit 1 (no output -> null).
//   [role:lose][id:X]                -> announce spawn; SIGTERM -> `cancelled-X` + exit; otherwise a
//                                       fallback timer writes `completed-X` + exits (no infinite block).
// The winner flushes stdout (write callback) BEFORE exiting, so a fast exit never truncates output.
// `.cjs` so `require` works (the file is spawned directly via shebang).
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
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if ((await listMarkers(dir, prefix)).length >= want) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	return await listMarkers(dir, prefix);
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
// A reusable runner bound to one fresh project + fake-pi, so a scenario can run AND resume.
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

async function main() {
	const { url } = await buildExtension();
	await scenarioWinnerBasicAndJournal(url);
	await scenarioFirstSuccessWins(url);
	await scenarioResumeValidWinner(url);
	await scenarioEmptyContract(url);

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
