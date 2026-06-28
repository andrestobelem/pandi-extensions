#!/usr/bin/env node
/**
 * Behavioral regression tests for the P1 usability fixes on the workflow monitor.
 *
 * Observable contracts:
 *   - Idle workflow status advertises the /workflows entrypoint (not a bare "wf"),
 *     so a first-time user can discover the monitor before any run exists.
 *   - On the Patterns tab, `n` scaffolds a pattern (matches the on-screen
 *     "Enter/n use pattern" hint) instead of being shadowed by the global tab jump.
 *   - On other tabs, `n` still jumps to the Agents tab (no regression).
 *   - Backspace no longer triggers a destructive delete; the Delete key still does.
 *   - Lines that overflow the width render a visible "…" truncation marker.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		failures.push(label + (detail ? `  [${detail}]` : ""));
		console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
	}
}

async function buildExtension() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-usability-fixes-"));

	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n",
	);
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} getText() { return ""; } setText() {} handleInput() {} render() { return []; } invalidate() {} }\n`,
	);
	const aiStub = path.join(outDir, "stub-ai.mjs");
	await fs.writeFile(aiStub, "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n");
	const tuiStub = path.join(outDir, "stub-tui.mjs");
	await fs.writeFile(
		tuiStub,
		`export class Image { constructor() {} input() {} render() { return []; } }\nexport const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\nexport function getCapabilities() { return { images: false }; }\nexport function matchesKey(data, key) { return data === key; }\nexport function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\nexport function visibleWidth(value) { return String(value).length; }\n`,
	);

	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "dynamic-workflows.mjs");
	const r = spawnSync(
		"npx",
		[
			"--yes",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:typebox=${typeboxStub}`,
			`--alias:typebox/value=${typeboxValueStub}`,
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--alias:@earendil-works/pi-ai=${aiStub}`,
			`--alias:@earendil-works/pi-tui=${tuiStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const pi = {
		events: { on: () => {} },
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: (key, opts) => shortcuts.push({ key, opts }),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, handlers, shortcuts };
}

function makeCtx(cwd, { editorReturns = "use-initial", customInputs = [] } = {}) {
	const customCalls = [];
	const setStatusCalls = [];
	const inputs = [...customInputs];
	const theme = { fg: (_color, value) => value, bg: (_color, value) => value, bold: (value) => value };
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			notify: () => {},
			setStatus: (key, value) => setStatusCalls.push({ key, value }),
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => (editorReturns === "use-initial" ? initial : editorReturns),
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
			custom: async (factory) => {
				const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
				// Live entry: `doneValue` keeps updating if the test drives the captured
				// component's handleInput after the dashboard has "closed".
				const entry = { component: null, lines: [], doneValue: undefined };
				const done = (value) => { entry.doneValue = value; };
				entry.component = factory(tui, theme, {}, done);
				while (inputs.length > 0 && typeof entry.component?.handleInput === "function") entry.component.handleInput(inputs.shift());
				entry.lines = typeof entry.component?.render === "function" ? entry.component.render(100) : [];
				customCalls.push(entry);
				return entry.doneValue ?? null;
			},
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "test-session-id",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "test-session.jsonl"),
			getSessionName: () => "Test session",
		},
	};
	return { ctx, customCalls, setStatusCalls };
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-usability-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function seedWorkflowFile(project) {
	const file = path.join(project, ".pi", "workflows", "sample.js");
	await fs.writeFile(file, "module.exports = async function workflow() { return 'ok'; };\n");
	return file;
}

async function seedFailedRun(project, { runId = "failrun-1", error = "BOOM_SENTINEL" } = {}) {
	const runDir = path.join(project, ".pi", "workflows", "runs", runId);
	await fs.mkdir(runDir, { recursive: true });
	const now = new Date().toISOString();
	const record = {
		workflow: "wf", scope: "project", file: path.join(project, ".pi", "workflows", "wf.js"),
		runId, runDir, ok: false, state: "failed", background: true,
		startedAt: now, endedAt: now, elapsedMs: 4200, agentCount: 2, logs: [], error, cachedCalls: 0,
	};
	await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify(record));
	return record;
}

async function bootExtension(url, project, ctxOptions) {
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, ctxOptions);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, state.ctx);
	return { ...state, commands };
}

function renderedText(call) {
	return (call?.lines ?? []).join("\n");
}

async function scenarioIdleStatusShowsEntrypoint(url) {
	const project = await makeProject();
	const { setStatusCalls } = await bootExtension(url, project);
	const idle = setStatusCalls.map((c) => String(c.value)).filter((v) => v.includes("wf"));
	check("idle status is set on session_start", idle.length >= 1, JSON.stringify(setStatusCalls));
	check("idle status advertises /workflows entrypoint", idle.some((v) => v.includes("/workflows")), JSON.stringify(idle));
}

async function scenarioPatternsAndMonitorN(url) {
	const project = await makeProject();
	// Patterns tab: `n` should scaffold a pattern (newPattern), not jump to Agents.
	const patterns = await bootExtension(url, project, { editorReturns: undefined, customInputs: ["p", "n"] });
	await patterns.commands.get("workflow").handler("dashboard", patterns.ctx);
	const pCall = patterns.customCalls[0];
	check("patterns `n` triggers use-pattern", pCall?.doneValue?.type === "newPattern", JSON.stringify(pCall?.doneValue));
	check("patterns `n` does not jump to Agents", !renderedText(pCall).includes("[Agents]"), renderedText(pCall).split("\n")[0]);

	// Monitor tab: `n` should still jump to Agents (no regression).
	const monitor = await bootExtension(url, project, { customInputs: ["n"] });
	await monitor.commands.get("workflow").handler("dashboard", monitor.ctx);
	const mCall = monitor.customCalls[0];
	check("monitor `n` still opens Agents tab", renderedText(mCall).includes("[Agents]"), renderedText(mCall).split("\n")[0]);
	check("monitor `n` does not trigger an action", mCall?.doneValue == null, JSON.stringify(mCall?.doneValue));
}

async function scenarioBackspaceVsDelete(url) {
	// Independent projects: the delete path unlinks the workflow file, so each
	// sub-scenario seeds its own file to stay order-independent.
	const backProject = await makeProject();
	await seedWorkflowFile(backProject);
	const back = await bootExtension(url, backProject, { customInputs: ["w", "backspace"] });
	await back.commands.get("workflow").handler("dashboard", back.ctx);
	const bCall = back.customCalls[0];
	check("backspace does not trigger a destructive delete", bCall?.doneValue == null, JSON.stringify(bCall?.doneValue));
	check("backspace leaves the dashboard open on Workflows", renderedText(bCall).includes("[Workflows]"), renderedText(bCall).split("\n")[0]);

	const delProject = await makeProject();
	await seedWorkflowFile(delProject);
	const del = await bootExtension(url, delProject, { customInputs: ["w", "delete"] });
	await del.commands.get("workflow").handler("dashboard", del.ctx);
	const dCall = del.customCalls[0];
	check("Delete key still triggers delete-workflow", dCall?.doneValue?.type === "deleteWorkflow", JSON.stringify(dCall?.doneValue));
}

// Drive the captured dashboard component directly to simulate the 1.5s refresh
// reordering lists under the cursor (lists are mtime-sorted on disk).
async function openDashboardComponent(url) {
	const project = await makeProject();
	const boot = await bootExtension(url, project, { customInputs: [] });
	await boot.commands.get("workflow").handler("dashboard", boot.ctx);
	const entry = boot.customCalls[0];
	return { component: entry.component, getDone: () => entry.doneValue };
}

async function scenarioRunsSelectionStability(url) {
	const { component, getDone } = await openDashboardComponent(url);
	const mkRun = (runId) => ({ runId, workflow: "wf", runDir: `/tmp/${runId}`, agentCount: 0, background: true, scope: "project" });
	component.setRuns([mkRun("A"), mkRun("B"), mkRun("C")]);
	component.handleInput("tab"); // monitor -> agents
	component.handleInput("tab"); // -> sessions
	component.handleInput("tab"); // -> runs
	component.handleInput("down"); // select run B (index 1)
	// A refresh reorders the list (B slides from index 1 to index 2).
	component.setRuns([mkRun("C"), mkRun("A"), mkRun("B")]);
	component.handleInput("d"); // delete the *selected* run
	const dv = getDone();
	check("runs: delete still targets the selected run after a reorder", dv?.type === "deleteRun" && dv?.run?.runId === "B", JSON.stringify(dv));
}

async function scenarioAgentsSelectionStability(url) {
	const { component, getDone } = await openDashboardComponent(url);
	const mkEntry = (runId, id) => ({ run: { runId, workflow: "wf", runDir: `/tmp/${runId}`, agentCount: 1, background: true, scope: "project" }, agent: { id, name: `a${id}`, state: "running", promptAvailable: true } });
	component.setAgentEntries([mkEntry("A", 1), mkEntry("B", 1), mkEntry("C", 1)]);
	component.handleInput("A"); // jump to Agents tab
	component.handleInput("down"); // select B#1 (index 1)
	// A refresh reorders entries (B#1 slides from index 1 to index 2).
	component.setAgentEntries([mkEntry("C", 1), mkEntry("A", 1), mkEntry("B", 1)]);
	component.handleInput("d"); // delete the selected agent's run
	const dv = getDone();
	check("agents: delete still targets the selected agent's run after a reorder", dv?.type === "deleteRun" && dv?.run?.runId === "B", JSON.stringify(dv));
}

async function scenarioListPaging(url) {
	const { component, getDone } = await openDashboardComponent(url);
	const runs = Array.from({ length: 25 }, (_, i) => ({ runId: `r${i}`, workflow: "wf", runDir: `/tmp/r${i}`, agentCount: 0, background: true, scope: "project" }));
	component.setRuns(runs);
	component.handleInput("tab"); // monitor -> agents
	component.handleInput("tab"); // -> sessions
	component.handleInput("tab"); // -> runs (index 0)

	component.handleInput("end");
	component.handleInput("v");
	check("End jumps to the last run", getDone()?.run?.runId === "r24", JSON.stringify(getDone()));

	component.handleInput("home");
	component.handleInput("v");
	check("Home jumps to the first run", getDone()?.run?.runId === "r0", JSON.stringify(getDone()));

	component.handleInput("pageDown");
	component.handleInput("v");
	check("PageDown jumps a page (10) down", getDone()?.run?.runId === "r10", JSON.stringify(getDone()));

	component.handleInput("pageUp");
	component.handleInput("v");
	check("PageUp jumps a page (10) up", getDone()?.run?.runId === "r0", JSON.stringify(getDone()));
}

async function scenarioRunningAgentLiveElapsed(url) {
	const { component } = await openDashboardComponent(url);
	const startedAt = new Date(Date.now() - 65000).toISOString();
	const entries = [{ run: { runId: "A", workflow: "wf", runDir: "/tmp/A", agentCount: 1, background: true, scope: "project" }, agent: { id: 1, name: "a1", state: "running", startedAt, promptAvailable: true } }];
	component.setAgentEntries(entries);
	component.handleInput("A"); // -> agents tab
	const text = component.render(100).join("\n");
	check("running agent shows live elapsed (not frozen elapsed:…)", /1m\d\ds/.test(text) && !text.includes("elapsed:…"), text.split("\n").find((l) => l.toLowerCase().includes("state:") || l.includes("elapsed")) ?? text.slice(0, 160));
}

async function scenarioListWindowIndicator(url) {
	const { component } = await openDashboardComponent(url);
	const now = new Date().toISOString();
	const runs = Array.from({ length: 25 }, (_, i) => ({ runId: `r${i}`, workflow: "wf", runDir: `/tmp/r${i}`, agentCount: 0, background: true, scope: "project", ok: false, state: "failed", startedAt: now, endedAt: now, elapsedMs: 1000, logs: [] }));
	component.setRuns(runs);
	component.handleInput("tab"); component.handleInput("tab"); component.handleInput("tab"); // -> runs
	const runsText = component.render(100).join("\n");
	check("runs header shows windowed position (a-b/total)", runsText.includes("/25"), runsText.split("\n").find((l) => l.includes("/25")) ?? runsText.slice(0, 160));

	const entries = Array.from({ length: 20 }, (_, i) => ({ run: { runId: `r${i}`, workflow: "wf", runDir: `/tmp/r${i}`, agentCount: 1, background: true, scope: "project" }, agent: { id: i, name: `a${i}`, state: "running", promptAvailable: true } }));
	component.setAgentEntries(entries);
	component.handleInput("A"); // -> agents
	const agentsText = component.render(100).join("\n");
	check("agents header shows windowed position (a-b/total)", agentsText.includes("/20"), agentsText.split("\n").find((l) => l.includes("/20")) ?? agentsText.slice(0, 160));
}

async function scenarioFailedRunErrorVisible(url) {
	const monProject = await makeProject();
	await seedFailedRun(monProject, { error: "BOOM_SENTINEL_ERR" });
	const mon = await bootExtension(url, monProject, { customInputs: [] });
	await mon.commands.get("workflow").handler("dashboard", mon.ctx);
	const monText = renderedText(mon.customCalls[0]);
	check("monitor surfaces the failed-run error inline", monText.includes("BOOM_SENTINEL_ERR"), monText.split("\n").filter((l) => l.toLowerCase().includes("error")).join(" | "));

	const runsProject = await makeProject();
	await seedFailedRun(runsProject, { error: "BOOM_SENTINEL_ERR" });
	const runs = await bootExtension(url, runsProject, { customInputs: ["tab", "tab", "tab"] });
	await runs.commands.get("workflow").handler("dashboard", runs.ctx);
	const runsText = renderedText(runs.customCalls[0]);
	check("runs tab surfaces the failed-run error inline", runsText.includes("BOOM_SENTINEL_ERR"), runsText.split("\n").filter((l) => l.toLowerCase().includes("error")).join(" | "));
}

async function scenarioEllipsisOnOverflow(url) {
	const project = await makeProject();
	const dash = await bootExtension(url, project, { customInputs: [] });
	await dash.commands.get("workflow").handler("dashboard", dash.ctx);
	const text = renderedText(dash.customCalls[0]);
	check("overflowing lines render a visible ellipsis marker", text.includes("…"), text.split("\n").slice(0, 2).join(" | "));
}

async function main() {
	const { url } = await buildExtension();
	await scenarioIdleStatusShowsEntrypoint(url);
	await scenarioPatternsAndMonitorN(url);
	await scenarioBackspaceVsDelete(url);
	await scenarioRunsSelectionStability(url);
	await scenarioAgentsSelectionStability(url);
	await scenarioListPaging(url);
	await scenarioFailedRunErrorVisible(url);
	await scenarioRunningAgentLiveElapsed(url);
	await scenarioListWindowIndicator(url);
	await scenarioEllipsisOnOverflow(url);

	if (failed > 0) {
		console.error("\nFailures:");
		for (const failure of failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
