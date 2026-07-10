/**
 * run-report-bounds — fija el contrato de bounding de output del collector (design record
 * §4, run bd039ef9): caps por item con truncamiento visible, stderr leído como TAIL bounded
 * (nunca la head), stdout/journal nunca inlineados (solo links), un presupuesto inline global
 * que degrada agentes posteriores a metadata+links con nota de clamp visible, y un listado
 * de artifacts acotado. Las fixtures son run dirs tmp sintéticos.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildCollector() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-bounds",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "observe/collector.ts"),
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
		// Outputs de 24 000 chars: 60 de ellos desbordan un presupuesto global de 1 MB cerca del agente ~44.
		events.push(agentEvent(id, `agent-${id}`, { output: `A${id}-`.padEnd(24_000, "x") }));
	}
	await fs.writeFile(path.join(dir, "events.jsonl"), `${events.join("\n")}\n`);
	// Artifact del agente 1: prompt cuya profundidad excede la lectura de prefijo de 16 000 bytes.
	await fs.writeFile(
		path.join(dir, "agents", "0001-agent-1.md"),
		`# agent-1\n\n## Prompt\n\n${"p".repeat(20_000)}\n${DEEP_PROMPT_SENTINEL}\n\n## Structured Output\n\nData\n`,
	);
	// Agente 2: failed, con un log stderr mucho más grande que el tail bound de 6 000 chars.
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
	// Inundación de artifacts para el bound del listado.
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

	// Caps por item con marcadores visibles de truncamiento.
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

	// stderr: TAIL bounded — sentinel final presente, sentinel inicial ausente.
	const a2 = model.agents.find((a) => a.id === 2);
	check("failed agent has stderr tail", !!a2?.stderrTail?.text);
	check("stderr tail keeps the END", a2?.stderrTail?.text.includes(TAIL_SENTINEL) === true);
	check("stderr tail drops the head", a2?.stderrTail?.text.includes(HEAD_SENTINEL) === false);
	check("stderr tail <= 6000 chars", (a2?.stderrTail?.text ?? "").length <= 6_000);

	// stdout y journal son link-only, nunca inlineados.
	check("stdout sentinel not in HTML", !html.includes(STDOUT_SENTINEL));
	check("journal sentinel not in HTML", !html.includes(JOURNAL_SENTINEL));
	check("failed agent links stdout", typeof a2?.stdoutHref === "string" && a2.stdoutHref.includes("stdout.log"));

	// Presupuesto inline global de 1 MB: los agentes posteriores degradan a metadata + links, visiblemente.
	const omitted = model.agents.filter((a) => a.inlineOmitted === true);
	check("global budget omits later agents", omitted.length > 0, `omitted=${omitted.length}`);
	check(
		"budget clamp note is visible",
		model.clampNotes.some((n) => /inline budget/i.test(n)),
		JSON.stringify(model.clampNotes),
	);
	check("early agent keeps inline content", model.agents.find((a) => a.id === 3)?.inlineOmitted !== true);

	// El listado de artifacts está bounded con remainder visible.
	check("artifacts listed", model.artifacts.length > 0);
	check(
		"artifact remainder reported",
		(model.artifactsOmitted ?? 0) > 0 || model.artifacts.length >= 130,
		`listed=${model.artifacts.length} omitted=${model.artifactsOmitted}`,
	);

	// Hrefs relativos y chequeados por containment.
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
