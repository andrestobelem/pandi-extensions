#!/usr/bin/env node
/**
 * Behavioral contract for the Graph sub-tab on the live agent detail view.
 *
 * Entering an agent from Monitor/Agents opens the sub-tabbed detail screen. The
 * Graph tab must render the same static workflow graph text/Mermaid fallback as
 * /workflow graph, without bouncing the user back to the dashboard.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makeTheme() {
	const id = (t) => t;
	return { fg: (_c, t) => t, bg: (_c, t) => t, bold: id, italic: id, underline: id, inverse: id, strikethrough: id };
}

async function waitForRender(component, predicate) {
	let rendered = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		rendered = component.render(120).join("\n");
		if (predicate(rendered)) return { ok: true, rendered };
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return { ok: false, rendered };
}

async function writeAgentEvents(runDir) {
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		`${JSON.stringify({ type: "agent", id: 1, name: "scout", state: "completed", output: "done", promptAvailable: false })}\n`,
		"utf8",
	);
}

async function makeProjectWithWorkflow() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-agent-graph-tab-"));
	const workflowDir = path.join(project, ".pi", "workflows");
	const runDir = path.join(workflowDir, "runs", "run-agent-graph-tab");
	await fs.mkdir(workflowDir, { recursive: true });
	await fs.mkdir(runDir, { recursive: true });
	const workflowFile = path.join(workflowDir, "graph-tab-demo.js");
	await fs.writeFile(
		workflowFile,
		`export default async function main() {
  const answer = await agent("inspect graph tab");
  await writeArtifact("answer.json", { answer });
  return answer;
}
`,
		"utf8",
	);
	await writeAgentEvents(runDir);
	return { project, runDir, workflowFile };
}

async function makeProjectWithoutWorkflow() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-agent-graph-missing-"));
	const runDir = path.join(project, ".pi", "workflows", "runs", "run-missing-graph-tab");
	await fs.mkdir(runDir, { recursive: true });
	await writeAgentEvents(runDir);
	return { project, runDir };
}

function makeRun({ workflow, runDir, workflowFile }) {
	return {
		workflow,
		scope: "project",
		...(workflowFile ? { file: workflowFile } : {}),
		runId: path.basename(runDir),
		runDir,
		state: "completed",
		ok: true,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:01.000Z",
		elapsedMs: 1000,
		agentCount: 1,
		logs: [],
	};
}

function makeAgent() {
	return { id: 1, name: "scout", state: "completed", output: "done", promptAvailable: false };
}

async function exerciseGraphTab(showLiveAgentView, { label, project, run, agent, assertGraph }) {
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: project,
		isProjectTrusted: () => true,
		ui: {
			theme: makeTheme(),
			notify: () => {},
			custom: async (factory) => {
				let doneValue;
				const tui = { terminal: { rows: 36, columns: 120 }, requestRender: () => {} };
				const component = factory(tui, ctx.ui.theme, {}, (value) => {
					doneValue = value;
				});

				const withGraphTab = await waitForRender(component, (rendered) =>
					/Card[\s\S]*Prompt[\s\S]*Graph[\s\S]*Output[\s\S]*Definition[\s\S]*Run/.test(rendered),
				);
				check(`${label}: tab bar lists the requested order`, withGraphTab.ok, withGraphTab.rendered);

				component.handleInput("3");
				check(
					`${label}: digit 3 activates the Graph tab`,
					component.getActiveTab() === "graph",
					component.getActiveTab(),
				);

				await assertGraph(component, label);

				component.handleInput("q");
				return doneValue;
			},
		},
	};

	await showLiveAgentView(ctx, run, agent);
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-agent-graph-tab",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "agent-view.ts"),
		outName: "agent-view.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	const { showLiveAgentView } = await loadModule(url);
	check("showLiveAgentView is exported", typeof showLiveAgentView === "function");

	const demo = await makeProjectWithWorkflow();
	await exerciseGraphTab(showLiveAgentView, {
		label: "graphable run",
		project: demo.project,
		run: makeRun({ workflow: "graph-tab-demo", runDir: demo.runDir, workflowFile: demo.workflowFile }),
		agent: makeAgent(),
		assertGraph: async (component, label) => {
			const graph = await waitForRender(
				component,
				(rendered) => /Workflow topology/.test(rendered) && /write artifact: answer\.json/.test(rendered),
			);
			check(`${label}: renders the static workflow graph`, graph.ok, graph.rendered);

			component.handleInput("end");
			const mermaid = await waitForRender(
				component,
				(rendered) => /Mermaid export/.test(rendered) && /flowchart TD/.test(rendered),
			);
			check(`${label}: includes the Mermaid fallback`, mermaid.ok, mermaid.rendered);
		},
	});

	const missing = await makeProjectWithoutWorkflow();
	await exerciseGraphTab(showLiveAgentView, {
		label: "missing workflow run",
		project: missing.project,
		run: makeRun({ workflow: "missing-graph-tab-demo", runDir: missing.runDir }),
		agent: makeAgent(),
		assertGraph: async (component, label) => {
			const fallback = await waitForRender(component, (rendered) =>
				/Cannot open graph: workflow file not found/.test(rendered),
			);
			check(`${label}: renders a clear fallback`, fallback.ok, fallback.rendered);
		},
	});

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
