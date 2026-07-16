#!/usr/bin/env node
/**
 * Claude Code's `Workflow` tool has no pi-style run directory (status.json/events.jsonl/
 * result.json) — instead it persists one JSON record per run at <sessionDir>/workflows/wf_<id>.json,
 * sibling to the raw per-agent transcripts under subagents/workflows/wf_<id>/. run-merge.mjs's
 * readClaudeRunData() adapts that shape to the same runData contract mergeNodes()/render.mjs expect
 * from a pi run dir. This suite pins that adapter directly (no CLI spawn needed — it's a pure
 * function over a constructed fixture), plus the real-run Mermaid diagram builder it feeds.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const RUN_MERGE = path.join(REPO_ROOT, ".claude", "scripts", "lib", "run-merge.mjs");

const { readRunData } = await import(pathToFileURL(RUN_MERGE).href);
const { check, counts } = createChecker();

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-run-record-"));

// A resultPreview this short can never round-trip through JSON.parse — real run-records truncate
// it hard, which is exactly why the adapter must prefer the agent transcript's full StructuredOutput
// tool_use over this field whenever the transcript is available.
const TRUNCATED_PREVIEW = '{"findings":[{"summary":"trunc';
const FULL_OUTPUT = {
	findings: [{ summary: "full untruncated finding text well past the preview cutoff", severity: "high" }],
};

async function writeFixture({ sessionDir, runId, agents, withTranscript = true }) {
	const record = {
		runId,
		status: "completed",
		agentCount: agents.length,
		durationMs: 5000,
		totalTokens: 4242,
		totalToolCalls: 7,
		logs: ["fixture log line"],
		result: { ok: true },
		workflowProgress: [
			{ type: "workflow_phase", index: 1, title: "Phase1" },
			...agents.map((a, i) => ({
				type: "workflow_agent",
				index: i + 1,
				label: a.label,
				phaseIndex: 1,
				phaseTitle: "Phase1",
				agentId: a.agentId,
				model: "claude-sonnet-5",
				state: a.state,
				startedAt: a.startedAt,
				durationMs: a.durationMs,
				attempt: a.attempt || 1,
				resultPreview: a.resultPreview ?? TRUNCATED_PREVIEW,
			})),
		],
	};
	const workflowsDir = path.join(sessionDir, "workflows");
	await fs.mkdir(workflowsDir, { recursive: true });
	await fs.writeFile(path.join(workflowsDir, `${runId}.json`), JSON.stringify(record));

	const transcriptDir = path.join(sessionDir, "subagents", "workflows", runId);
	await fs.mkdir(transcriptDir, { recursive: true });
	for (const a of agents) {
		if (!withTranscript || !a.fullOutput) continue;
		const lines = [
			JSON.stringify({ type: "user", message: { role: "user", content: "prompt" } }),
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", name: "StructuredOutput", input: a.fullOutput }],
				},
			}),
			JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
		];
		await fs.writeFile(path.join(transcriptDir, `agent-${a.agentId}.jsonl`), lines.join("\n") + "\n");
	}
	return { workflowsDir, transcriptDir, jsonPath: path.join(workflowsDir, `${runId}.json`) };
}

try {
	// --- fixture: 2 agents, one overlapping-timestamp pair would go here, but for THIS fixture
	// we want one done+one failed to check ok/fail/byRole/metrics/integrity in one pass. ---
	const runId = "wf_fixture001";
	const sessionDir = path.join(tmp, "session1");
	const { transcriptDir, jsonPath } = await writeFixture({
		sessionDir,
		runId,
		agents: [
			{
				agentId: "agentA1",
				label: "review:alpha",
				state: "done",
				startedAt: 1000,
				durationMs: 500,
				fullOutput: FULL_OUTPUT,
			},
			{
				agentId: "agentB1",
				label: "review:beta",
				state: "failed",
				startedAt: 1000,
				durationMs: 300,
				resultPreview: "",
			},
		],
	});

	// --- entry point 1: point --run straight at the transcript dir (subagents/workflows/wf_<id>/),
	// the shape the ultracode skill's own docs tell you to pass. ---
	const runData = readRunData(transcriptDir);
	check(
		"adapter detects a Claude-format run from the transcript dir",
		!!runData,
		"readRunData returned null/undefined",
	);
	if (runData) {
		check("state comes from record.status", runData.state === "completed", runData.state);
		check("agentCount matches the fixture", runData.agentCount === 2, String(runData.agentCount));
		check("ok counts the done agent", runData.ok === 1, String(runData.ok));
		check("fail counts the failed agent", runData.fail === 1, String(runData.fail));
		check(
			"metrics.totalTokens comes from the record",
			runData.metrics?.totalTokens === 4242,
			JSON.stringify(runData.metrics),
		);
		check("metrics.retries is 0 (both attempt 1)", runData.metrics?.retries === 0, JSON.stringify(runData.metrics));
		check("integrity.failed matches fail count", runData.integrity?.failed === 1, JSON.stringify(runData.integrity));
		check(
			"integrity.emptyOutput catches the done-but-empty-preview case is NOT triggered by the failed agent's empty preview (failed agents aren't DONE)",
			runData.integrity?.emptyOutput === 0,
			JSON.stringify(runData.integrity),
		);

		const alpha =
			runData.byRole?.get("review:alpha") ||
			runData.byRole?.get("review alpha") ||
			[...(runData.byRole?.values() || [])].find((g) => g.role.includes("alpha"));
		check("byRole has an entry for the done agent", !!alpha, [...(runData.byRole?.keys() || [])].join(","));
		if (alpha) {
			check(
				"output prefers the FULL transcript StructuredOutput over the truncated resultPreview",
				alpha.output === JSON.stringify(FULL_OUTPUT),
				String(alpha.output).slice(0, 80),
			);
		}

		check(
			"runAgents has one entry per agent",
			(runData.runAgents || []).length === 2,
			String(runData.runAgents?.length),
		);
		const runAgentA = (runData.runAgents || []).find((a) => a.id === "agentA1");
		check("runAgents normalizes 'done' to 'completed'", runAgentA?.state === "completed", runAgentA?.state);
	}

	// --- entry point 2: point --run at the workflows/ dir containing wf_<id>.json (picks newest). ---
	const runDataFromWorkflowsDir = readRunData(path.dirname(jsonPath));
	check(
		"entry point 2 (workflows/ dir) resolves to the same run",
		runDataFromWorkflowsDir?.runId === runId,
		runDataFromWorkflowsDir?.runId,
	);

	// --- entry point 3: point --run directly at the wf_<id>.json file. ---
	const runDataFromJsonFile = readRunData(jsonPath);
	check(
		"entry point 3 (direct .json path) resolves to the same run",
		runDataFromJsonFile?.runId === runId,
		runDataFromJsonFile?.runId,
	);

	// --- fallback: an agent transcript is missing entirely (archived/moved run) — must fall back
	// to resultPreview rather than throwing, and still report the run as a whole. ---
	const runId2 = "wf_fixture002";
	const sessionDir2 = path.join(tmp, "session2");
	const { transcriptDir: transcriptDir2 } = await writeFixture({
		sessionDir: sessionDir2,
		runId: runId2,
		agents: [
			{
				agentId: "agentC1",
				label: "solo",
				state: "done",
				startedAt: 1000,
				durationMs: 100,
				resultPreview: "plain text output, not json",
			},
		],
		withTranscript: false,
	});
	const runData2 = readRunData(transcriptDir2);
	check(
		"missing transcript falls back to resultPreview instead of throwing",
		!!runData2,
		"readRunData threw or returned null",
	);
	const solo = runData2 && [...runData2.byRole.values()][0];
	check("fallback output is the resultPreview text", solo?.output === "plain text output, not json", solo?.output);

	// --- unknown state + corrupt transcript line + agentCount divergence, one fixture. The state
	// "blocked" is deliberately in NO set (DONE/FAIL/ACTIVE): it must land in `unknown` and normalize
	// to runAgents state "other", not crash or miscount. agentCount=5 with only 2 events pins the
	// `record.agentCount ?? events.length` precedence (planned must be the max, not the event count).
	const runId4 = "wf_fixture004";
	const sessionDir4 = path.join(tmp, "session4");
	const { transcriptDir: transcriptDir4 } = await writeFixture({
		sessionDir: sessionDir4,
		runId: runId4,
		agents: [
			{ agentId: "agentD1", label: "weird", state: "blocked", startedAt: 1000, durationMs: 100, resultPreview: "x" },
			{
				agentId: "agentD2",
				label: "reader",
				state: "done",
				startedAt: 1000,
				durationMs: 100,
				resultPreview: "preview text",
			},
		],
		withTranscript: false,
	});
	const record4Path = path.join(sessionDir4, "workflows", `${runId4}.json`);
	const record4 = JSON.parse(await fs.readFile(record4Path, "utf8"));
	record4.agentCount = 5;
	await fs.writeFile(record4Path, JSON.stringify(record4));
	// Corrupt transcript: a mid-write truncated tool_use line plus a trailing garbage line — the
	// per-line try/catch in tryReadFullAgentOutput must skip them and fall back to resultPreview.
	await fs.writeFile(
		path.join(transcriptDir4, "agent-agentD2.jsonl"),
		[
			'{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"StructuredOutput","inp',
			"%%% not json at all %%%",
		].join("\n") + "\n",
	);
	const runData4 = readRunData(transcriptDir4);
	check(
		"unknown state lands in `unknown`, not ok/fail",
		runData4?.unknown === 1 && runData4?.ok === 1 && runData4?.fail === 0,
		JSON.stringify({ ok: runData4?.ok, fail: runData4?.fail, unknown: runData4?.unknown }),
	);
	const weirdAgent = (runData4?.runAgents || []).find((a) => a.id === "agentD1");
	check("unknown state normalizes to runAgents state 'other'", weirdAgent?.state === "other", weirdAgent?.state);
	check(
		"agentCount honours the record over the event count (5 declared, 2 events)",
		runData4?.agentCount === 5 && runData4?.progress?.total === 5,
		`agentCount=${runData4?.agentCount} total=${runData4?.progress?.total}`,
	);
	const reader = runData4 && [...runData4.byRole.values()].find((g) => g.role.includes("reader"));
	check(
		"corrupt transcript lines are skipped and output falls back to resultPreview",
		reader?.output === "preview text",
		reader?.output,
	);

	// (Las waves del diagrama Mermaid del run se pinean en la fuente canónica de pi —
	// observe/html-mermaid.ts — vía la suite de observe; acá solo se pinea el ADAPTER de datos.)

	// --- LIVE journal fallback: mid-run there is no wf_<id>.json yet — only journal.jsonl inside
	// the transcript dir ("started"/"result" per agentId, full result inline). The adapter must
	// build a partial running view from it, and the record must WIN once it exists. ---
	const runId3 = "wf_fixture003";
	const sessionDir3 = path.join(tmp, "session3");
	const liveDir = path.join(sessionDir3, "subagents", "workflows", runId3);
	await fs.mkdir(liveDir, { recursive: true });
	const LIVE_RESULT = { verdict: "ok", detail: "full inline result from the journal entry" };
	await fs.writeFile(
		path.join(liveDir, "journal.jsonl"),
		[
			JSON.stringify({ type: "started", key: "v2:aaa", agentId: "live1" }),
			JSON.stringify({ type: "started", key: "v2:bbb", agentId: "live2" }),
			JSON.stringify({ type: "result", key: "v2:aaa", agentId: "live1", result: LIVE_RESULT }),
		].join("\n") + "\n",
	);
	await fs.writeFile(
		path.join(liveDir, "agent-live1.jsonl"),
		[
			JSON.stringify({
				type: "user",
				timestamp: "2026-07-16T19:00:00.000Z",
				message: { role: "user", content: "Review dimension alpha\nrest of the prompt body" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-07-16T19:00:30.000Z",
				message: {
					role: "assistant",
					usage: { output_tokens: 350 },
					content: [
						{ type: "tool_use", name: "Read", input: {} },
						{ type: "tool_use", name: "Grep", input: {} },
					],
				},
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-07-16T19:01:00.000Z",
				message: { role: "assistant", usage: { output_tokens: 150 }, content: [{ type: "text", text: "done" }] },
			}),
		].join("\n") + "\n",
	);
	const liveData = readRunData(liveDir);
	check("journal fallback detects a mid-run dir with no wf record", !!liveData, "readRunData returned null");
	if (liveData) {
		check(
			"live view is active/running",
			liveData.active === true && liveData.state === "running",
			`${liveData.state}/${liveData.active}`,
		);
		check(
			"live view counts one done + one running",
			liveData.ok === 1 && liveData.running === 1,
			`ok=${liveData.ok} running=${liveData.running}`,
		);
		check(
			"live progress is open-ended (started-agents are a floor, not the plan)",
			liveData.progress?.openEnded === true,
			JSON.stringify(liveData.progress),
		);
		check(
			"live view omits integrity chips (partial data would fabricate zeros)",
			liveData.integrity == null,
			JSON.stringify(liveData.integrity),
		);
		const liveGroups = [...liveData.byRole.values()];
		const withOutput = liveGroups.find((g) => g.output);
		check(
			"live output is the FULL inline journal result",
			withOutput?.output === JSON.stringify(LIVE_RESULT),
			withOutput?.output,
		);
		const labeled = liveGroups.find((g) => g.role.includes("alpha"));
		check("live role label comes from the prompt's first line", !!labeled, liveGroups.map((g) => g.role).join(","));
		check(
			"live metrics sum output tokens across transcripts",
			liveData.metrics?.totalTokens === 500,
			JSON.stringify(liveData.metrics),
		);
		check(
			"live metrics count tool calls across transcripts",
			liveData.metrics?.totalToolCalls === 2,
			JSON.stringify(liveData.metrics),
		);
		const liveAgent1 = (liveData.runAgents || []).find((a) => a.id === "live1");
		check(
			"live runAgents carry REAL transcript timestamps (first line -> last activity)",
			liveAgent1?.startedAt === Date.parse("2026-07-16T19:00:00.000Z") &&
				liveAgent1?.endedAt === Date.parse("2026-07-16T19:01:00.000Z"),
			JSON.stringify(liveAgent1),
		);
		const liveAgent2 = (liveData.runAgents || []).find((a) => a.id === "live2");
		check(
			"agent with no transcript yet has null timestamps (single-wave fallback, no invented seriality)",
			liveAgent2?.startedAt === null && liveAgent2?.endedAt === null,
			JSON.stringify(liveAgent2),
		);
	}
	// Once the run completes and the record appears, the record adapter must take priority.
	const workflowsDir3 = path.join(sessionDir3, "workflows");
	await fs.mkdir(workflowsDir3, { recursive: true });
	await fs.writeFile(
		path.join(workflowsDir3, `${runId3}.json`),
		JSON.stringify({
			runId: runId3,
			status: "completed",
			agentCount: 2,
			workflowProgress: [],
		}),
	);
	const afterRecord = readRunData(liveDir);
	check(
		"record wins over the journal once it exists",
		afterRecord?.state === "completed" && afterRecord?.runId === runId3,
		`${afterRecord?.state}/${afterRecord?.runId}`,
	);

	// --- priority guard: a directory with BOTH status.json (pi format) and a stray wf_*.json must
	// still resolve as pi format — the Claude-record branch only engages when status.json is absent. ---
	const piDir = path.join(tmp, "pi-style-run");
	await fs.mkdir(piDir, { recursive: true });
	await fs.writeFile(
		path.join(piDir, "status.json"),
		JSON.stringify({ runId: "pi-run-id", state: "completed", agentCount: 0 }),
	);
	await fs.writeFile(path.join(piDir, "events.jsonl"), "");
	await fs.writeFile(
		path.join(piDir, "wf_should-be-ignored.json"),
		JSON.stringify({ runId: "wrong-id", status: "completed", agentCount: 99, workflowProgress: [] }),
	);
	const piRunData = readRunData(piDir);
	check(
		"status.json present takes priority over a stray wf_*.json (pi format wins)",
		piRunData?.runId === "pi-run-id",
		piRunData?.runId,
	);
} finally {
	await fs.rm(tmp, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
