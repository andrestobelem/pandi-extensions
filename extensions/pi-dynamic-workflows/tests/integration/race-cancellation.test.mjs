/**
 * Behavioral integration tests for the `race()` global + in-flight subagent cancellation.
 *
 * Runs real workflows through the Worker with a faked `pi` agent subprocess
 * (PI_DYNAMIC_WORKFLOWS_PI_COMMAND). Each branch's role is encoded in its prompt
 * ([role:...][id:...][need:N]) so one flexible fake-pi covers every scenario:
 *
 *   winner-basic       — race returns the winner's value/index/status "won"; the two in-flight
 *                        LOSERS each receive a real SIGTERM (winner untouched); and the journal
 *                        holds ONLY the winner's record (cancelled losers leave holes, not records).
 *   first-success-wins — a branch that FAILS fast (-> null) never wins; a later branch wins and the
 *                        healthy loser is still cancelled. Proves accept-semantics + first SUCCESS.
 *   concurrency<branches — with concurrency 1, an instant winner settles before the queued losers
 *                        ever spawn; they throw the pre-spawn guard (B1 regime b) -> 0 spawns, 0 kills.
 *   empty-contract     — all branches fail -> { winner:null, index:-1, status:"empty" }; journal clean.
 *
 * Follow-ups not covered here (the impl is in place; deterministic tests are pending): the
 * concurrency<branches pre-spawn-guard regime (B1 regime b) and resume re-selection (B2 yields a
 * VALID winner, not necessarily the same one) — both need timing harnesses without forever-blocking
 * fakes, which would otherwise deadlock or flake.
 *
 * Determinism: a filesystem barrier (the winner waits for `spawned-*` markers), never sleeps; after a
 * run we poll (bounded) for the SIGTERM markers the kill produces.
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
//   [role:lose][id:X]                -> announce spawn, SIGTERM -> `cancelled-X`, block until killed.
// `.cjs` so `require` works (the file is spawned directly via shebang).
async function writeFakePi(outDir, barrierDir, tag) {
	const fakePi = path.join(outDir, `fake-pi-${tag}.cjs`);
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = process.argv[process.argv.length - 1] || "";
const dir = ${JSON.stringify(barrierDir)};
function marker(name) { try { fs.writeFileSync(path.join(dir, name), "x"); } catch {} }
function emit(text) {
  process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n");
}
const id = (/\\[id:([a-z0-9]+)\\]/.exec(prompt) || [])[1] || "x";
if (/\\[role:win-barrier\\]/.test(prompt)) {
  const need = Number((/\\[need:(\\d+)\\]/.exec(prompt) || [])[1] || "2");
  const start = Date.now();
  (function poll() {
    let n = 0;
    try { n = fs.readdirSync(dir).filter((f) => f.startsWith("spawned-")).length; } catch {}
    if (n >= need || Date.now() - start > 8000) { marker("won-" + id); emit("WON-OUTPUT"); process.exit(0); }
    else setTimeout(poll, 15);
  })();
} else if (/\\[role:win-now\\]/.test(prompt)) {
  marker("won-" + id); emit("WON-OUTPUT"); process.exit(0);
} else if (/\\[role:fail\\]/.test(prompt)) {
  marker("spawned-" + id); process.exit(1);
} else {
  process.on("SIGTERM", () => { marker("cancelled-" + id); process.exit(143); });
  marker("spawned-" + id);
  setInterval(() => {}, 1000);
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
async function runRace(url, { prompts, concurrency, maxAgents }) {
	const mod = await import(`${url}?i=${tagSeq}`);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "race-smoke.js"), `${WORKFLOW}\n`, "utf8");
	const barrierDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-race-barrier-"));
	const fakePi = await writeFakePi(barrierDir, barrierDir, `race-${tagSeq++}`);

	const result = await withFakePi(fakePi, async () => {
		const { pi, tools } = makePi();
		(ext.activate ?? ext)(pi, makeCtx(project));
		const res = await tools
			.get("dynamic_workflow")
			.execute(
				"tc-race",
				{ action: "run", name: "race-smoke", input: { prompts }, concurrency, maxAgents, timeoutMs: 60_000 },
				new AbortController().signal,
				undefined,
				makeCtx(project),
			);
		return res?.details?.result;
	});
	return { result, barrierDir };
}

async function scenarioWinnerBasicAndJournal(url) {
	const { result, barrierDir } = await runRace(url, {
		prompts: [
			"[role:win-barrier][id:winner][need:2] produce the answer",
			"[role:lose][id:loser1] slow",
			"[role:lose][id:loser2] slow",
		],
		concurrency: 3,
		maxAgents: 4,
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

	// Journal: only the winner is recorded; cancelled losers leave holes, never records (B2/I-hole).
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
	// branch 0 fails fast (-> null, must not win); branch 1 is the barrier winner; branch 2 blocks.
	const { result, barrierDir } = await runRace(url, {
		prompts: [
			"[role:fail][id:fail0] dud",
			"[role:win-barrier][id:winner][need:2] answer",
			"[role:lose][id:loser2] slow",
		],
		concurrency: 3,
		maxAgents: 4,
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

async function scenarioEmptyContract(url) {
	const { result } = await runRace(url, {
		prompts: ["[role:fail][id:a] dud", "[role:fail][id:b] dud", "[role:fail][id:c] dud"],
		concurrency: 3,
		maxAgents: 4,
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
