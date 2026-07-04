/**
 * run-report-bounds — pins the collector's output-bounding contract (design record
 * §4, run bd039ef9): per-item caps with visible truncation, stderr read as a bounded
 * TAIL (never the head), stdout/journal never inlined (links only), a global inline
 * budget that degrades later agents to metadata+links with a visible clamp note, and
 * a bounded artifacts listing. Fixtures are synthetic tmp run dirs.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildCollector() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-bounds",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "run-report-collector.ts"),
		outName: "run-report-collector.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return await import(url);
}

const HEAD_SENTINEL = "HEAD-SENTINEL-c3b1";
const TAIL_SENTINEL = "TAIL-SENTINEL-9f2e";
const STDOUT_SENTINEL = "STDOUT-SENTINEL-77aa";
const JOURNAL_SENTINEL = "JOURNAL-SENTINEL-51dd";
const DEEP_PROMPT_SENTINEL = "DEEP-PROMPT-SENTINEL-0b44";

async function makeRunDir(name) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	await fs.mkdir(path.join(dir, "agents"), { recursive: true });
	return dir;
}

function agentEvent(id, name, extra = {}) {
	return JSON.stringify({ type: "agent", id, name, ok: true, state: "completed", elapsedMs: 1000, ...extra });
}

async function writeOversizedFixture() {
	const dir = await makeRunDir("run-report-oversized");
	const status = {
		workflow: "oversized",
		scope: "project",
		file: path.join(dir, "wf.js"),
		runId: "run-oversized",
		runDir: dir,
		state: "completed",
		background: true,
		active: false,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:10:00.000Z",
		endedAt: "2026-01-01T00:10:00.000Z",
		elapsedMs: 600000,
		agentCount: 60,
		logs: [{ time: "2026-01-01T00:00:01.000Z", message: "log with huge details", details: "d".repeat(5000) }],
	};
	await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(status));
	const events = [];
	for (let id = 1; id <= 60; id++) {
		// 24 000-char outputs: 60 of them overflow a 1 MB global budget around agent ~44.
		events.push(agentEvent(id, `agent-${id}`, { output: `A${id}-`.padEnd(24_000, "x") }));
	}
	await fs.writeFile(path.join(dir, "events.jsonl"), `${events.join("\n")}\n`);
	// Agent 1 artifact: prompt whose depth exceeds the 16 000-byte prefix read.
	await fs.writeFile(
		path.join(dir, "agents", "0001-agent-1.md"),
		`# agent-1\n\n## Prompt\n\n${"p".repeat(20_000)}\n${DEEP_PROMPT_SENTINEL}\n\n## Structured Output\n\nData\n`,
	);
	// Agent 2: failed, with a stderr log far larger than the 6 000-char tail bound.
	await fs.writeFile(
		path.join(dir, "agents", "0002-agent-2.md"),
		"# agent-2\n\n## Prompt\n\nshort prompt\n\n## Stderr\n\nboom\n",
	);
	const events2 = JSON.stringify({ type: "agent", id: 2, name: "agent-2", ok: false, code: 1, state: "failed" });
	await fs.appendFile(path.join(dir, "events.jsonl"), `${events2}\n`);
	await fs.writeFile(
		path.join(dir, "agents", "0002-agent-2.stderr.log"),
		`${HEAD_SENTINEL}\n${"e".repeat(50_000)}\n${TAIL_SENTINEL}\n`,
	);
	await fs.writeFile(path.join(dir, "agents", "0002-agent-2.stdout.log"), `${STDOUT_SENTINEL}\n${"o".repeat(1000)}\n`);
	await fs.writeFile(path.join(dir, "journal.jsonl"), `{"v":1,"note":"${JOURNAL_SENTINEL}"}\n`);
	// Artifact flood for the listing bound.
	for (let i = 0; i < 130; i++) await fs.writeFile(path.join(dir, `artifact-${String(i).padStart(3, "0")}.txt`), "x");
	return dir;
}

async function main() {
	const mod = await buildCollector();
	check("collectRunReport exported", typeof mod.collectRunReport === "function");
	check("buildRunReportHtml re-exported for adapters", typeof mod.buildRunReportHtml === "function");

	const dir = await writeOversizedFixture();
	const model = await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
	const html = mod.buildRunReportHtml(model);

	// Per-item caps with visible truncation markers.
	const a1 = model.agents.find((a) => a.id === 1);
	check("agent output inline <= 24000", (a1?.output?.text ?? "").length <= 24_000);
	check(
		"prompt bounded by 16000-byte prefix read",
		!!a1?.prompt && !a1.prompt.text.includes(DEEP_PROMPT_SENTINEL) && a1.prompt.text.length <= 16_000,
		`len=${a1?.prompt?.text?.length}`,
	);
	check(
		"log details capped at 500",
		(model.logs[0]?.details ?? "").length <= 520,
		String(model.logs[0]?.details?.length),
	);

	// stderr: bounded TAIL — end sentinel present, head sentinel absent.
	const a2 = model.agents.find((a) => a.id === 2);
	check("failed agent has stderr tail", !!a2?.stderrTail?.text);
	check("stderr tail keeps the END", a2?.stderrTail?.text.includes(TAIL_SENTINEL) === true);
	check("stderr tail drops the head", a2?.stderrTail?.text.includes(HEAD_SENTINEL) === false);
	check("stderr tail <= 6000 chars", (a2?.stderrTail?.text ?? "").length <= 6_000);

	// stdout and journal are link-only, never inlined.
	check("stdout sentinel not in HTML", !html.includes(STDOUT_SENTINEL));
	check("journal sentinel not in HTML", !html.includes(JOURNAL_SENTINEL));
	check("failed agent links stdout", typeof a2?.stdoutHref === "string" && a2.stdoutHref.includes("stdout.log"));

	// Global 1 MB inline budget: later agents degrade to metadata + links, visibly.
	const omitted = model.agents.filter((a) => a.inlineOmitted === true);
	check("global budget omits later agents", omitted.length > 0, `omitted=${omitted.length}`);
	check(
		"budget clamp note is visible",
		model.clampNotes.some((n) => /inline budget/i.test(n)),
		JSON.stringify(model.clampNotes),
	);
	check("early agent keeps inline content", model.agents.find((a) => a.id === 3)?.inlineOmitted !== true);

	// Artifacts listing is bounded with a visible remainder.
	check("artifacts listed", model.artifacts.length > 0);
	check(
		"artifact remainder reported",
		(model.artifactsOmitted ?? 0) > 0 || model.artifacts.length >= 130,
		`listed=${model.artifacts.length} omitted=${model.artifactsOmitted}`,
	);

	// Relative, containment-checked hrefs.
	check("artifact href relative to run dir", a2?.artifactHref === "agents/0002-agent-2.md", String(a2?.artifactHref));

	if (counts.failed > 0) {
		console.error(`\n${counts.failed} checks FAILED:`);
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
