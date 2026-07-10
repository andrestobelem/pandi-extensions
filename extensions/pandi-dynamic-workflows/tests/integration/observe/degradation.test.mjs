/**
 * run-report-degradation — fija la matriz de graceful-degradation del collector (design
 * record §5, run bd039ef9): runs partial/running/failed/cancelled/stale, agentes crashed e
 * interrupted, archivos faltantes, determinismo (sin lecturas wall-clock; byte-stable
 * para un generatedAt fijo), detección de code-drift y hard error para dirs vacíos.
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
		name: "pi-run-report-degradation",
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

async function makeRunDir(name) {
	return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function baseStatus(dir, extra = {}) {
	return {
		workflow: "degradation",
		scope: "project",
		file: path.join(dir, "wf.js"),
		runId: "run-degradation",
		runDir: dir,
		state: "completed",
		background: true,
		active: false,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:05:00.000Z",
		endedAt: "2026-01-01T00:05:00.000Z",
		elapsedMs: 300000,
		agentCount: 1,
		logs: [],
		...extra,
	};
}

async function main() {
	const mod = await buildCollector();

	// 1) Dir vacío: hard error, nunca un HTML vacío.
	{
		const dir = await makeRunDir("run-report-empty");
		let threw = false;
		try {
			await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		} catch {
			threw = true;
		}
		check("empty dir throws", threw);
	}

	// 2) Dir solo con status (sin result/events/metrics/input): renderiza + lista archivos faltantes.
	{
		const dir = await makeRunDir("run-report-status-only");
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir)));
		const model = await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		check("status-only renders", model.workflow === "degradation");
		check(
			"missing files reported",
			["result.json", "events.jsonl", "metrics.json"].every((f) => model.missingFiles.includes(f)),
			JSON.stringify(model.missingFiles),
		);
		check("scriptPath relativized or omitted (no $HOME leak)", !(model.scriptPath ?? "").startsWith("/"));
	}

	// 3) Dir running ajeno: postura snapshot, liveness unverified, sin claim de staleness.
	{
		const dir = await makeRunDir("run-report-foreign-running");
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify(baseStatus(dir, { state: "running", endedAt: undefined })),
		);
		const model = await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		check("foreign running keeps state running", model.state === "running");
		check("foreign running is liveness-unverified", model.liveness === "unverified");
		const html = mod.buildRunReportHtml(model);
		check("no meta refresh emitted", !/http-equiv\s*=\s*"refresh"/i.test(html));
		check("no client-side ticker", !/setInterval|setTimeout/.test(html));
		check("generatedAt embedded", html.includes("2026-01-02T00:00:00.000Z"));
	}

	// 4) El veredicto stale in-session se renderiza verbatim (report ≡ TUI).
	{
		const dir = await makeRunDir("run-report-stale");
		const status = baseStatus(dir, { state: "running" });
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(status));
		const model = await mod.collectRunReport(dir, {
			generatedAt: "2026-01-02T00:00:00.000Z",
			liveStatus: { ...status, state: "stale", active: false },
		});
		check("liveStatus stale wins", model.state === "stale");
		check("in-session liveness verified", model.liveness === "verified");
	}

	// 5) Run failed: el error aparece; la derivación cancelled coincide con semántica de getRunState.
	{
		const dir = await makeRunDir("run-report-failed");
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir, { state: "failed" })));
		await fs.writeFile(
			path.join(dir, "result.json"),
			JSON.stringify({ ...baseStatus(dir), ok: false, error: "cancelled by user", state: undefined }),
		);
		const model = await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		check("cancel substring derives cancelled state", model.state === "cancelled", model.state);
		check("error message surfaces", model.error === "cancelled by user");
	}

	// 6) Agente crasheado (evento start-only) en un run terminal -> "interrupted", fail card abierta.
	{
		const dir = await makeRunDir("run-report-crashed-agent");
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir, { state: "failed" })));
		await fs.writeFile(
			path.join(dir, "events.jsonl"),
			`${JSON.stringify({ type: "log", time: "2026-01-01T00:00:01.000Z", message: "agent 1 start: worker" })}\n`,
		);
		await fs.mkdir(path.join(dir, "agents"), { recursive: true });
		await fs.writeFile(path.join(dir, "agents", "0001-worker.stderr.log"), "segfault evidence\n");
		const model = await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		const agent = model.agents.find((a) => a.id === 1);
		check("crashed agent present", !!agent);
		check("running-agent-on-terminal-run becomes interrupted", agent?.state === "interrupted", agent?.state);
		check("crash keeps stderr evidence", agent?.stderrTail?.text.includes("segfault evidence") === true);
	}

	// 7) Determinismo: fixture idéntica + generatedAt -> HTML byte-identical.
	{
		const dir = await makeRunDir("run-report-determinism");
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir)));
		const one = mod.buildRunReportHtml(await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" }));
		const two = mod.buildRunReportHtml(await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" }));
		check("byte-stable for fixed generatedAt", one === two);
	}

	// 8) Code drift: script cambiado -> "changed"; script faltante -> "missing".
	{
		const dir = await makeRunDir("run-report-drift");
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir, { codeHash: "abc123" })));
		const changed = await mod.collectRunReport(dir, {
			generatedAt: "2026-01-02T00:00:00.000Z",
			currentScriptCode: "export default async function main() { return 1; }",
		});
		check("hash mismatch -> changed", changed.codeDrift === "changed", changed.codeDrift);
		const missing = await mod.collectRunReport(dir, {
			generatedAt: "2026-01-02T00:00:00.000Z",
			currentScriptCode: null,
		});
		check("missing script -> missing", missing.codeDrift === "missing", missing.codeDrift);
	}

	// 9) Líneas corruptas de events.jsonl se saltean; agents se backfillean desde el scan de agents/.
	{
		const dir = await makeRunDir("run-report-corrupt");
		await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir)));
		await fs.writeFile(path.join(dir, "events.jsonl"), 'not-json\n{"type":\n');
		await fs.mkdir(path.join(dir, "agents"), { recursive: true });
		await fs.writeFile(path.join(dir, "agents", "0007-scan-only.md"), "# scan-only\n\n## Prompt\n\nhi\n");
		const model = await mod.collectRunReport(dir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		check("corrupt lines tolerated", model.workflow === "degradation");
		check(
			"agents backfilled from dir scan",
			model.agents.some((a) => a.id === 7),
			JSON.stringify(model.agents.map((a) => a.id)),
		);
	}

	// 10) runDir RELATIVO (como lo invocan humanos desde la raíz del repo): los hrefs deben seguir siendo
	// relativos al run-dir — en ese caso el scan de agents/ registra paths de artifacts relativos al cwd.
	{
		const rel = path.join(".pi", "tmp", `run-report-relative-${process.pid}`);
		const dir = path.join(REPO_ROOT, rel);
		await fs.mkdir(path.join(dir, "agents"), { recursive: true });
		try {
			await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(baseStatus(dir)));
			await fs.writeFile(path.join(dir, "agents", "0001-worker.md"), "# worker\n\n## Prompt\n\nhi\n");
			const prevCwd = process.cwd();
			process.chdir(REPO_ROOT);
			try {
				const model = await mod.collectRunReport(rel, { generatedAt: "2026-01-02T00:00:00.000Z" });
				const agent = model.agents.find((a) => a.id === 1);
				check(
					"relative runDir yields run-dir-relative href",
					agent?.artifactHref === "agents/0001-worker.md",
					String(agent?.artifactHref),
				);
			} finally {
				process.chdir(prevCwd);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

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
