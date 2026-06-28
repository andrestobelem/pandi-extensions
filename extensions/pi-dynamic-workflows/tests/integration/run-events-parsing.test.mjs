/**
 * Characterization tests for the run-events parsing cluster of pi-dynamic-workflows.
 *
 * These pin the CURRENT observable behavior of the pure value coercers, the
 * agent-monitor merge logic, the phase/elapsed derivations, and the events.jsonl
 * parsing pipeline (readRunEvents) BEFORE that cluster is moved into a sibling
 * module. They are a safety net for the byte-identical extraction (the Refactor
 * step of Red -> Green -> Refactor): they pass against the cluster in index.ts
 * today and must keep passing after it is relocated, proving no behavior changed.
 *
 * Self-bootstrapping like the other dynamic-workflows suites: esbuilds the CURRENT
 * extension (so it tracks index.ts + every sibling module it imports) with the SDK/
 * tui/typebox aliased to local stubs, then imports the bundle's named exports. No
 * model or agent subprocess is involved — every function under test is synchronous
 * or reads a fixture directory on disk.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/run-events-parsing.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension as sharedBuildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-run-events-integration",
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

function scenarioValueCoercers(mod) {
	const { recordValue, stringValue, numberValue, booleanValue, stringArrayValue, isAgentMonitorState } = mod;

	// recordValue: plain non-null non-array object -> itself; everything else -> undefined.
	check("recordValue keeps a plain object", recordValue({ a: 1 })?.a === 1, JSON.stringify(recordValue({ a: 1 })));
	check("recordValue rejects null", recordValue(null) === undefined, String(recordValue(null)));
	check("recordValue rejects arrays", recordValue([1, 2]) === undefined, String(recordValue([1, 2])));
	check("recordValue rejects primitives", recordValue("x") === undefined && recordValue(5) === undefined, "x/5");

	// stringValue / numberValue / booleanValue: strict typeof, finite for numbers.
	check("stringValue keeps a string", stringValue("hi") === "hi", String(stringValue("hi")));
	check("stringValue rejects non-strings", stringValue(5) === undefined && stringValue(null) === undefined, "5/null");
	check(
		"numberValue keeps a finite number incl. 0",
		numberValue(5) === 5 && numberValue(0) === 0,
		`${numberValue(5)}/${numberValue(0)}`,
	);
	check(
		"numberValue rejects NaN/Infinity/strings",
		numberValue(NaN) === undefined && numberValue(Infinity) === undefined && numberValue("5") === undefined,
		"NaN/Inf/'5'",
	);
	check(
		"booleanValue keeps booleans",
		booleanValue(true) === true && booleanValue(false) === false,
		`${booleanValue(true)}/${booleanValue(false)}`,
	);
	check(
		"booleanValue rejects truthy non-booleans",
		booleanValue(0) === undefined && booleanValue("true") === undefined,
		"0/'true'",
	);

	// stringArrayValue: array of ALL strings -> array; any non-string -> undefined; [] -> [].
	check(
		"stringArrayValue keeps an all-string array",
		JSON.stringify(stringArrayValue(["a", "b"])) === JSON.stringify(["a", "b"]),
		JSON.stringify(stringArrayValue(["a", "b"])),
	);
	check(
		"stringArrayValue rejects a mixed array",
		stringArrayValue(["a", 1]) === undefined,
		String(stringArrayValue(["a", 1])),
	);
	check(
		"stringArrayValue keeps an empty array",
		Array.isArray(stringArrayValue([])) && stringArrayValue([]).length === 0,
		JSON.stringify(stringArrayValue([])),
	);
	check("stringArrayValue rejects non-arrays", stringArrayValue("a") === undefined, String(stringArrayValue("a")));

	// isAgentMonitorState: exactly the five known states.
	const good = ["running", "completed", "failed", "cached", "unknown"].every((s) => isAgentMonitorState(s) === true);
	check("isAgentMonitorState accepts the five known states", good, "running/completed/failed/cached/unknown");
	check(
		"isAgentMonitorState rejects others",
		isAgentMonitorState("nope") === false && isAgentMonitorState(undefined) === false,
		"nope/undefined",
	);
}

function scenarioDerivations(mod) {
	const { getAgentElapsedMs, formatAgentPhase, phaseEventFields } = mod;

	// getAgentElapsedMs: recorded value wins; running uses startedAt clamped to >= 0; otherwise undefined.
	check(
		"getAgentElapsedMs returns the recorded elapsedMs",
		getAgentElapsedMs({ state: "running", elapsedMs: 1234 }) === 1234,
		String(getAgentElapsedMs({ state: "running", elapsedMs: 1234 })),
	);
	check(
		"getAgentElapsedMs is undefined for a finished agent with no elapsedMs",
		getAgentElapsedMs({ state: "completed" }) === undefined,
		String(getAgentElapsedMs({ state: "completed" })),
	);
	const future = new Date(Date.now() + 1_000_000).toISOString();
	check(
		"getAgentElapsedMs clamps a future startedAt to 0 while running",
		getAgentElapsedMs({ state: "running", startedAt: future }) === 0,
		String(getAgentElapsedMs({ state: "running", startedAt: future })),
	);
	check(
		"getAgentElapsedMs is undefined when running with no startedAt",
		getAgentElapsedMs({ state: "running" }) === undefined,
		String(getAgentElapsedMs({ state: "running" })),
	);
	check(
		"getAgentElapsedMs is undefined for an unparseable startedAt",
		getAgentElapsedMs({ state: "running", startedAt: "nope" }) === undefined,
		String(getAgentElapsedMs({ state: "running", startedAt: "nope" })),
	);

	// formatAgentPhase: needs truthy index AND total; phaseId prefixes "P{id} ".
	check(
		"formatAgentPhase renders index/total",
		formatAgentPhase({ phaseIndex: 1, phaseTotal: 3 }) === "1/3",
		String(formatAgentPhase({ phaseIndex: 1, phaseTotal: 3 })),
	);
	check(
		"formatAgentPhase prefixes the batch id",
		formatAgentPhase({ phaseId: 2, phaseIndex: 1, phaseTotal: 3 }) === "P2 1/3",
		String(formatAgentPhase({ phaseId: 2, phaseIndex: 1, phaseTotal: 3 })),
	);
	check(
		"formatAgentPhase is undefined when index is 0/falsy",
		formatAgentPhase({ phaseIndex: 0, phaseTotal: 3 }) === undefined,
		String(formatAgentPhase({ phaseIndex: 0, phaseTotal: 3 })),
	);
	check(
		"formatAgentPhase is undefined without a total",
		formatAgentPhase({ phaseIndex: 1 }) === undefined,
		String(formatAgentPhase({ phaseIndex: 1 })),
	);

	// phaseEventFields: empty for missing/zero-total phase; otherwise id/index/total (+ optional label).
	check(
		"phaseEventFields is empty for undefined",
		JSON.stringify(phaseEventFields(undefined)) === "{}",
		JSON.stringify(phaseEventFields(undefined)),
	);
	check(
		"phaseEventFields is empty for total <= 0",
		JSON.stringify(phaseEventFields({ id: 1, index: 1, total: 0 })) === "{}",
		JSON.stringify(phaseEventFields({ id: 1, index: 1, total: 0 })),
	);
	check(
		"phaseEventFields maps id/index/total without a label",
		JSON.stringify(phaseEventFields({ id: 2, index: 1, total: 3 })) ===
			JSON.stringify({ phaseId: 2, phaseIndex: 1, phaseTotal: 3 }),
		JSON.stringify(phaseEventFields({ id: 2, index: 1, total: 3 })),
	);
	check(
		"phaseEventFields includes a non-empty label",
		phaseEventFields({ id: 2, index: 1, total: 3, label: "build" }).phaseLabel === "build",
		JSON.stringify(phaseEventFields({ id: 2, index: 1, total: 3, label: "build" })),
	);
}

function scenarioMergeAgentMonitor(mod) {
	const { mergeAgentMonitor } = mod;

	const fresh = mergeAgentMonitor(undefined, {
		id: 1,
		name: "alpha",
		state: "running",
		startedAt: "T1",
	});
	check(
		"merge: new agent keeps id/name/state/startedAt",
		fresh.id === 1 && fresh.name === "alpha" && fresh.state === "running" && fresh.startedAt === "T1",
		JSON.stringify(fresh),
	);
	check(
		"merge: new agent without artifact is promptAvailable=false",
		fresh.promptAvailable === false,
		JSON.stringify(fresh),
	);
	check("merge: new running agent has no endedAt", fresh.endedAt === undefined, JSON.stringify(fresh));

	const finishedToRunning = mergeAgentMonitor(
		{ id: 1, name: "alpha", state: "completed" },
		{ id: 1, name: "alpha", state: "running" },
	);
	check(
		"merge: a completed agent is NOT regressed to running",
		finishedToRunning.state === "completed",
		finishedToRunning.state,
	);
	const cachedToRunning = mergeAgentMonitor(
		{ id: 1, name: "alpha", state: "cached" },
		{ id: 1, name: "alpha", state: "running" },
	);
	check(
		"merge: a cached agent is NOT regressed to running",
		cachedToRunning.state === "cached",
		cachedToRunning.state,
	);

	const ended = mergeAgentMonitor(
		{ id: 1, name: "alpha", state: "running", startedAt: "T1" },
		{ id: 1, name: "alpha", state: "completed", endedAt: "T2", elapsedMs: 7 },
	);
	check(
		"merge: running -> completed applies the terminal state",
		ended.state === "completed" && ended.endedAt === "T2" && ended.elapsedMs === 7,
		JSON.stringify(ended),
	);
	check(
		"merge: running -> completed preserves the earlier startedAt",
		ended.startedAt === "T1",
		JSON.stringify(ended),
	);

	const noName = mergeAgentMonitor(undefined, { id: 5, name: "" });
	check("merge: empty name falls back to agent-{id}", noName.name === "agent-5", noName.name);

	const withArtifact = mergeAgentMonitor(undefined, {
		id: 1,
		name: "alpha",
		artifactPath: "/runs/agents/0001-alpha.md",
	});
	check(
		"merge: an artifactPath makes promptAvailable=true",
		withArtifact.promptAvailable === true && withArtifact.artifactPath === "/runs/agents/0001-alpha.md",
		JSON.stringify(withArtifact),
	);
	const keepsPrompt = mergeAgentMonitor(
		{ id: 1, name: "alpha", state: "running", promptAvailable: true },
		{ id: 1, name: "alpha" },
	);
	check(
		"merge: an existing promptAvailable=true is preserved",
		keepsPrompt.promptAvailable === true,
		JSON.stringify(keepsPrompt),
	);
}

async function scenarioReadRunEvents(mod) {
	const { readRunEvents } = mod;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-events-fixture-"));

	const lines = [
		JSON.stringify({ type: "log", time: "T1", message: "agent 1 start: my agent" }),
		JSON.stringify({
			type: "log",
			time: "T2",
			message: "agent 1 end: my agent",
			details: { ok: true, code: 0, elapsedMs: 500 },
		}),
		JSON.stringify({ type: "log", time: "T3", message: "workflow start: x" }),
		"this-line-is-not-json",
		"",
		JSON.stringify({ type: "agent", id: 2, name: "second", ok: false, code: 1 }),
	];
	await fs.writeFile(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
	const parsed = await readRunEvents(dir);

	check(
		"readRunEvents collects only the log events (malformed/blank lines ignored)",
		parsed.logs.length === 3,
		`logs=${parsed.logs.length}`,
	);
	check(
		"readRunEvents preserves log order",
		parsed.logs.map((l) => l.time).join(",") === "T1,T2,T3",
		parsed.logs.map((l) => l.time).join(","),
	);
	check(
		"readRunEvents keeps the first log message verbatim",
		parsed.logs[0].message === "agent 1 start: my agent",
		parsed.logs[0].message,
	);

	check(
		"readRunEvents derives 2 agents sorted by id",
		parsed.agents.length === 2 && parsed.agents[0].id === 1 && parsed.agents[1].id === 2,
		JSON.stringify(parsed.agents.map((a) => a.id)),
	);
	const a1 = parsed.agents.find((a) => a.id === 1);
	check(
		"readRunEvents merges 'agent N start' + 'agent N end' (ok:true) into a completed agent",
		a1.state === "completed" &&
			a1.name === "my agent" &&
			a1.startedAt === "T1" &&
			a1.endedAt === "T2" &&
			a1.elapsedMs === 500 &&
			a1.code === 0 &&
			a1.ok === true,
		JSON.stringify(a1),
	);
	const a2 = parsed.agents.find((a) => a.id === 2);
	check(
		"readRunEvents maps an 'agent' event with ok:false to a failed agent",
		a2.state === "failed" && a2.name === "second" && a2.code === 1 && a2.ok === false,
		JSON.stringify(a2),
	);

	const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-events-empty-"));
	const missing = await readRunEvents(emptyDir);
	check(
		"readRunEvents tolerates a missing events.jsonl",
		missing.logs.length === 0 && missing.agents.length === 0,
		JSON.stringify(missing),
	);
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(`${url}?i=0`);

	scenarioValueCoercers(mod);
	scenarioDerivations(mod);
	scenarioMergeAgentMonitor(mod);
	await scenarioReadRunEvents(mod);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
