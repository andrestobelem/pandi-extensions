#!/usr/bin/env node
/**
 * Tests de regresión conductual para los arreglos P1 de usabilidad en el monitor de workflows.
 *
 * Contratos observables:
 *   - El estado idle de workflow anuncia el entrypoint /workflows (no un "wf" pelado),
 *     para que un usuario nuevo pueda descubrir el monitor antes de que exista cualquier run.
 *   - En la tab Patterns, `n` scaffolda un pattern (coincide con el hint en pantalla
 *     "Enter/n use pattern") en vez de quedar sombreado por el salto global de tab.
 *   - En otras tabs, `n` todavía salta a la tab Agents (sin regresión).
 *   - Backspace ya no dispara un borrado destructivo; la tecla Delete todavía lo hace.
 *   - Las líneas que desbordan el ancho renderizan un marcador visible de truncamiento "…".
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-usability-fixes",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
	});
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
	const theme = {
		fg: (_color, value) => value,
		bg: (_color, value) => value,
		bold: (value) => value,
	};
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
				// Entry viva: `doneValue` sigue actualizándose si el test maneja el handleInput
				// del componente capturado después de que el dashboard se haya "cerrado".
				const entry = { component: null, lines: [], doneValue: undefined };
				const done = (value) => {
					entry.doneValue = value;
				};
				entry.component = factory(tui, theme, {}, done);
				while (inputs.length > 0 && typeof entry.component?.handleInput === "function")
					entry.component.handleInput(inputs.shift());
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
		workflow: "wf",
		scope: "project",
		file: path.join(project, ".pi", "workflows", "wf.js"),
		runId,
		runDir,
		ok: false,
		state: "failed",
		background: true,
		startedAt: now,
		endedAt: now,
		elapsedMs: 4200,
		agentCount: 2,
		logs: [],
		error,
		cachedCalls: 0,
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
	check(
		"idle status advertises /workflows entrypoint",
		idle.some((v) => v.includes("/workflows")),
		JSON.stringify(idle),
	);
}

async function scenarioPatternsAndMonitorN(url) {
	const project = await makeProject();
	// Tab Patterns: `n` debe scaffoldar un pattern (newPattern), no saltar a Agents.
	const patterns = await bootExtension(url, project, {
		editorReturns: undefined,
		customInputs: ["p", "n"],
	});
	await patterns.commands.get("workflow").handler("dashboard", patterns.ctx);
	const pCall = patterns.customCalls[0];
	check(
		"patterns `n` triggers use-pattern",
		pCall?.doneValue?.type === "newPattern",
		JSON.stringify(pCall?.doneValue),
	);
	check(
		"patterns `n` does not jump to Agents",
		!renderedText(pCall).includes("[Agents]"),
		renderedText(pCall).split("\n")[0],
	);

	// Tab Monitor: `n` todavía debe saltar a Agents (sin regresión).
	const monitor = await bootExtension(url, project, { customInputs: ["n"] });
	await monitor.commands.get("workflow").handler("dashboard", monitor.ctx);
	const mCall = monitor.customCalls[0];
	check(
		"monitor `n` still opens Agents tab",
		renderedText(mCall).includes("[Agents]"),
		renderedText(mCall).split("\n")[0],
	);
	check("monitor `n` does not trigger an action", mCall?.doneValue == null, JSON.stringify(mCall?.doneValue));
}

async function scenarioBackspaceVsDelete(url) {
	// Proyectos independientes: la ruta delete deslinkea el archivo de workflow, así que cada
	// subescenario siembra su propio archivo para mantenerse independiente del orden.
	const backProject = await makeProject();
	await seedWorkflowFile(backProject);
	const back = await bootExtension(url, backProject, { customInputs: ["w", "backspace"] });
	await back.commands.get("workflow").handler("dashboard", back.ctx);
	const bCall = back.customCalls[0];
	check("backspace does not trigger a destructive delete", bCall?.doneValue == null, JSON.stringify(bCall?.doneValue));
	check(
		"backspace leaves the dashboard open on Workflows",
		renderedText(bCall).includes("[Workflows]"),
		renderedText(bCall).split("\n")[0],
	);

	const delProject = await makeProject();
	await seedWorkflowFile(delProject);
	const del = await bootExtension(url, delProject, { customInputs: ["w", "delete"] });
	await del.commands.get("workflow").handler("dashboard", del.ctx);
	const dCall = del.customCalls[0];
	check(
		"Delete key still triggers delete-workflow",
		dCall?.doneValue?.type === "deleteWorkflow",
		JSON.stringify(dCall?.doneValue),
	);
}

// Manejamos directamente el componente de dashboard capturado para simular el refresh de 1.5s
// reordenando listas bajo el cursor (las listas se ordenan por mtime en disco).
async function openDashboardComponent(url) {
	const project = await makeProject();
	const boot = await bootExtension(url, project, { customInputs: [] });
	await boot.commands.get("workflow").handler("dashboard", boot.ctx);
	const entry = boot.customCalls[0];
	return { component: entry.component, getDone: () => entry.doneValue };
}

async function scenarioRunsSelectionStability(url) {
	const { component, getDone } = await openDashboardComponent(url);
	const mkRun = (runId) => ({
		runId,
		workflow: "wf",
		runDir: `/tmp/${runId}`,
		agentCount: 0,
		background: true,
		scope: "project",
	});
	component.setRuns([mkRun("A"), mkRun("B"), mkRun("C")]);
	component.handleInput("tab"); // monitor -> agents
	component.handleInput("tab"); // -> sessions
	component.handleInput("tab"); // -> runs
	component.handleInput("down"); // selecciona run B (índice 1)
	// Un refresh reordena la lista (B se desliza del índice 1 al índice 2).
	component.setRuns([mkRun("C"), mkRun("A"), mkRun("B")]);
	component.handleInput("d"); // borra el run *seleccionado*
	const dv = getDone();
	check(
		"runs: delete still targets the selected run after a reorder",
		dv?.type === "deleteRun" && dv?.run?.runId === "B",
		JSON.stringify(dv),
	);
}

async function scenarioAgentsSelectionStability(url) {
	const { component, getDone } = await openDashboardComponent(url);
	const mkEntry = (runId, id) => ({
		run: {
			runId,
			workflow: "wf",
			runDir: `/tmp/${runId}`,
			agentCount: 1,
			background: true,
			scope: "project",
		},
		agent: { id, name: `a${id}`, state: "running", promptAvailable: true },
	});
	component.setAgentEntries([mkEntry("A", 1), mkEntry("B", 1), mkEntry("C", 1)]);
	component.handleInput("A"); // salta a la tab Agents
	component.handleInput("down"); // selecciona B#1 (índice 1)
	// Un refresh reordena entries (B#1 se desliza del índice 1 al índice 2).
	component.setAgentEntries([mkEntry("C", 1), mkEntry("A", 1), mkEntry("B", 1)]);
	component.handleInput("d"); // borra el run del agente seleccionado
	const dv = getDone();
	check(
		"agents: delete still targets the selected agent's run after a reorder",
		dv?.type === "deleteRun" && dv?.run?.runId === "B",
		JSON.stringify(dv),
	);
}

async function scenarioListPaging(url) {
	const { component, getDone } = await openDashboardComponent(url);
	const runs = Array.from({ length: 25 }, (_, i) => ({
		runId: `r${i}`,
		workflow: "wf",
		runDir: `/tmp/r${i}`,
		agentCount: 0,
		background: true,
		scope: "project",
	}));
	component.setRuns(runs);
	component.handleInput("tab"); // monitor -> agents
	component.handleInput("tab"); // -> sessions
	component.handleInput("tab"); // -> runs (índice 0)

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

async function scenarioReopenAfterAction(url) {
	const project = await makeProject();
	await seedFailedRun(project, { runId: "delme", error: "x" });
	const boot = await bootExtension(url, project, { customInputs: ["tab", "tab", "tab", "d"] }); // -> tab runs, borra seleccionado
	await boot.commands.get("workflow").handler("dashboard", boot.ctx);
	check(
		"dashboard reopens after a (delete) action instead of exiting",
		boot.customCalls.length === 2,
		`customCalls=${boot.customCalls.length}`,
	);
	const reopened = renderedText(boot.customCalls[boot.customCalls.length - 1]);
	check("reopened dashboard preserves the active tab (Runs)", reopened.includes("[Runs]"), reopened.split("\n")[0]);
}

async function scenarioHelpOverlay(url) {
	const project = await makeProject();

	const open = await bootExtension(url, project, { customInputs: ["?"] });
	await open.commands.get("workflow").handler("dashboard", open.ctx);
	const helpText = renderedText(open.customCalls[0]);
	check(
		"? opens a keyboard help overlay",
		helpText.includes("ayuda de teclado") && helpText.includes("PgUp"),
		helpText.split("\n")[0],
	);
	check("help overlay documents close", helpText.toLowerCase().includes("cierra"), helpText.split("\n").slice(-1)[0]);

	const dismissed = await bootExtension(url, project, { customInputs: ["?", "x"] });
	await dismissed.commands.get("workflow").handler("dashboard", dismissed.ctx);
	const after = renderedText(dismissed.customCalls[0]);
	check(
		"any key dismisses the help overlay",
		!after.includes("ayuda de teclado") && after.includes("[Monitor]"),
		after.split("\n")[0],
	);

	const hint = await bootExtension(url, project, { customInputs: [] });
	await hint.commands.get("workflow").handler("dashboard", hint.ctx);
	check(
		"dashboard advertises the ? help shortcut",
		renderedText(hint.customCalls[0]).includes("? ayuda"),
		renderedText(hint.customCalls[0]).split("\n")[1],
	);
}

async function scenarioRunningAgentLiveElapsed(url) {
	const { component } = await openDashboardComponent(url);
	const startedAt = new Date(Date.now() - 65000).toISOString();
	const entries = [
		{
			run: {
				runId: "A",
				workflow: "wf",
				runDir: "/tmp/A",
				agentCount: 1,
				background: true,
				scope: "project",
			},
			agent: { id: 1, name: "a1", state: "running", startedAt, promptAvailable: true },
		},
	];
	component.setAgentEntries(entries);
	component.handleInput("A"); // -> tab agents
	const text = component.render(100).join("\n");
	check(
		"running agent shows live elapsed (not frozen elapsed:…)",
		/1m\d\ds/.test(text) && !text.includes("elapsed:…"),
		text.split("\n").find((l) => l.toLowerCase().includes("state:") || l.includes("elapsed")) ?? text.slice(0, 160),
	);
}

async function scenarioListWindowIndicator(url) {
	const { component } = await openDashboardComponent(url);
	const now = new Date().toISOString();
	const runs = Array.from({ length: 25 }, (_, i) => ({
		runId: `r${i}`,
		workflow: "wf",
		runDir: `/tmp/r${i}`,
		agentCount: 0,
		background: true,
		scope: "project",
		ok: false,
		state: "failed",
		startedAt: now,
		endedAt: now,
		elapsedMs: 1000,
		logs: [],
	}));
	component.setRuns(runs);
	component.handleInput("tab");
	component.handleInput("tab");
	component.handleInput("tab"); // -> runs
	const runsText = component.render(100).join("\n");
	check(
		"runs header shows windowed position (a-b/total)",
		runsText.includes("/25"),
		runsText.split("\n").find((l) => l.includes("/25")) ?? runsText.slice(0, 160),
	);

	const entries = Array.from({ length: 20 }, (_, i) => ({
		run: {
			runId: `r${i}`,
			workflow: "wf",
			runDir: `/tmp/r${i}`,
			agentCount: 1,
			background: true,
			scope: "project",
		},
		agent: { id: i, name: `a${i}`, state: "running", promptAvailable: true },
	}));
	component.setAgentEntries(entries);
	component.handleInput("A"); // -> agents
	const agentsText = component.render(100).join("\n");
	check(
		"agents header shows windowed position (a-b/total)",
		agentsText.includes("/20"),
		agentsText.split("\n").find((l) => l.includes("/20")) ?? agentsText.slice(0, 160),
	);
}

async function scenarioFailedRunErrorVisible(url) {
	const monProject = await makeProject();
	await seedFailedRun(monProject, { error: "BOOM_SENTINEL_ERR" });
	const mon = await bootExtension(url, monProject, { customInputs: [] });
	await mon.commands.get("workflow").handler("dashboard", mon.ctx);
	const monText = renderedText(mon.customCalls[0]);
	check(
		"monitor surfaces the failed-run error inline",
		monText.includes("BOOM_SENTINEL_ERR"),
		monText
			.split("\n")
			.filter((l) => l.toLowerCase().includes("error"))
			.join(" | "),
	);

	const runsProject = await makeProject();
	await seedFailedRun(runsProject, { error: "BOOM_SENTINEL_ERR" });
	const runs = await bootExtension(url, runsProject, { customInputs: ["tab", "tab", "tab"] });
	await runs.commands.get("workflow").handler("dashboard", runs.ctx);
	const runsText = renderedText(runs.customCalls[0]);
	check(
		"runs tab surfaces the failed-run error inline",
		runsText.includes("BOOM_SENTINEL_ERR"),
		runsText
			.split("\n")
			.filter((l) => l.toLowerCase().includes("error"))
			.join(" | "),
	);
}

async function scenarioEllipsisOnOverflow(url) {
	const project = await makeProject();
	const dash = await bootExtension(url, project, { customInputs: [] });
	await dash.commands.get("workflow").handler("dashboard", dash.ctx);
	const text = renderedText(dash.customCalls[0]);
	check(
		"overflowing lines render a visible ellipsis marker",
		text.includes("…"),
		text.split("\n").slice(0, 2).join(" | "),
	);
}

async function scenarioMonitorHelpGating(url) {
	// El banner superior de ayuda antes anunciaba 'c/x cancel' y 'r rerun' incluso cuando el
	// run seleccionado no se podía cancelar/rerun, contradiciendo la fila de detail gateada.
	const { component } = await openDashboardComponent(url);
	const now = new Date().toISOString();
	const mkModel = (runId, canCancel, canRerun) => ({
		run: {
			runId,
			workflow: "wf",
			runDir: `/tmp/${runId}`,
			agentCount: 0,
			background: true,
			scope: "project",
			ok: !canCancel,
			state: canCancel ? "running" : "completed",
			startedAt: now,
			elapsedMs: 1000,
			logs: [],
		},
		runId,
		runDir: `/tmp/${runId}`,
		workflow: "wf",
		state: canCancel ? "running" : "completed",
		active: canCancel,
		stale: false,
		priority: canCancel ? "active" : "latest",
		elapsedMs: 1000,
		agentsDone: 0,
		agentsStarted: 0,
		parallelAgents: 0,
		bashDone: 0,
		artifactCount: 0,
		agents: [],
		canCancel,
		canRerun,
	});
	const helpLine = () => component.render(300)[1];

	component.setMonitorModels([mkModel("ACT", true, false)]); // run activo
	const active = helpLine();
	check("monitor help advertises cancel for an active run", active.includes("cancel"), active);
	check("monitor help hides delete for an active run", !active.includes("delete run"), active);

	component.setMonitorModels([mkModel("DONE", false, true)]); // run terminado
	const done = helpLine();
	check("monitor help hides cancel for a finished run", !done.includes("cancel"), done);
	check(
		"monitor help offers rerun + delete for a finished run",
		done.includes("rerun") && done.includes("delete run"),
		done,
	);
}

async function scenarioMonitorMultiRun(url) {
	// Monitor antes renderizaba un único run aunque hubiera varios activos (la
	// barra muestra "▶ N active"). Debe exponer todos los runs activos y cambiar foco.
	const { component, getDone } = await openDashboardComponent(url);
	const now = new Date().toISOString();
	const mkModel = (runId) => ({
		run: {
			runId,
			workflow: "wf",
			runDir: `/tmp/${runId}`,
			agentCount: 0,
			background: true,
			scope: "project",
			ok: false,
			state: "running",
			startedAt: now,
			elapsedMs: 1000,
			logs: [],
		},
		runId,
		runDir: `/tmp/${runId}`,
		workflow: "wf",
		state: "running",
		active: true,
		stale: false,
		priority: "active",
		elapsedMs: 1000,
		agentsDone: 0,
		agentsStarted: 2,
		agentConcurrency: 2,
		parallelAgents: 1,
		peakParallelAgents: 1,
		bashDone: 0,
		artifactCount: 0,
		agents: [],
		canCancel: true,
		canRerun: false,
	});
	component.setMonitorModels([mkModel("RUN_AAA"), mkModel("RUN_BBB")]);
	const shown = component.render(120).join("\n");
	check(
		"monitor lists all active runs, not just one",
		shown.includes("RUN_AAA") && shown.includes("RUN_BBB"),
		shown.split("\n").slice(0, 10).join(" | "),
	);

	component.handleInput("]"); // enfoca el segundo run activo
	component.handleInput("v"); // ve el run enfocado
	const dv = getDone();
	check(
		"monitor ] switches the focused active run",
		dv?.type === "view" && dv?.run?.runId === "RUN_BBB",
		JSON.stringify(dv),
	);
}

async function scenarioAgentsJumpToFailed(url) {
	// Agents anuncia failed:N pero, antes de esto, solo existía navegación ↑↓; encontrar los
	// agentes fallidos (la razón para abrir la tab) implicaba scroll manual. 'f' debe saltar.
	const { component, getDone } = await openDashboardComponent(url);
	const mk = (runId, id, state) => ({
		run: {
			runId,
			workflow: "wf",
			runDir: `/tmp/${runId}`,
			agentCount: 1,
			background: true,
			scope: "project",
		},
		agent: { id, name: `a${id}`, state, promptAvailable: true },
	});
	component.setAgentEntries([
		mk("A", 1, "running"),
		mk("B", 1, "running"),
		mk("C", 1, "failed"),
		mk("D", 1, "running"),
	]);
	component.handleInput("A"); // tab Agents (agentIndex empieza en 0)
	component.handleInput("f"); // salta al siguiente agente fallido
	component.handleInput("o"); // abre el agente seleccionado
	const dv = getDone();
	check(
		"agents: 'f' jumps to the next failed agent",
		dv?.type === "agent" && dv?.agent?.state === "failed" && dv?.run?.runId === "C",
		JSON.stringify(dv),
	);
}

async function scenarioRefreshFreshnessAndErrors(url) {
	// El refresh de dashboard de 1.5s envuelve lecturas de disco; una falla debe seguir visible
	// (no una unhandled rejection silenciosa) y un refresh sano debe anunciar recencia.
	const { component } = await openDashboardComponent(url);
	const initial = component.render(100).join("\n");
	check(
		"dashboard header advertises refresh recency",
		initial.includes("actualizado hace"),
		initial.split("\n").slice(0, 2).join(" | "),
	);

	component.markRefreshError("BOOM_REFRESH_SENTINEL");
	const errored = component.render(100).join("\n");
	check(
		"refresh failure is surfaced in the header",
		errored.includes("falló el refresh") && errored.includes("BOOM_REFRESH_SENTINEL"),
		errored.split("\n").slice(0, 2).join(" | "),
	);

	component.markRefreshOk();
	const recovered = component.render(100).join("\n");
	check(
		"a healthy refresh clears the failure marker",
		recovered.includes("actualizado hace") && !recovered.includes("falló el refresh"),
		recovered.split("\n").slice(0, 2).join(" | "),
	);
}

async function scenarioRunActionsConsistentAcrossTabs(url) {
	// Contrato SIMPLICITY: los atajos de acciones de run (g graph, v view, d delete) los
	// maneja un único helper compartido, así que deben resolver a la MISMA selección
	// en cada tab con runs (monitor, agents, runs, activity). Esto ancla el handler
	// deduplicado contra drift entre las ramas previamente copiadas.
	const { component, getDone } = await openDashboardComponent(url);
	const run = {
		runId: "SHARED",
		workflow: "wf",
		runDir: "/tmp/SHARED",
		agentCount: 1,
		background: true,
		scope: "project",
		ok: true,
		state: "completed",
	};
	component.setRuns([run]);
	component.setActivity([
		{ runId: "SHARED", workflow: "wf", time: new Date().toISOString(), message: "done", state: "completed" },
	]);
	component.setAgentEntries([{ run, agent: { id: 1, name: "a1", state: "completed", promptAvailable: true } }]);
	component.setMonitorModels([
		{
			run,
			runId: "SHARED",
			runDir: "/tmp/SHARED",
			workflow: "wf",
			state: "completed",
			active: false,
			stale: false,
			priority: "latest",
			elapsedMs: 1,
			agentsDone: 1,
			agentsStarted: 1,
			parallelAgents: 0,
			bashDone: 0,
			artifactCount: 0,
			agents: [],
			canCancel: false,
			canRerun: true,
		},
	]);

	const tabs = [
		{ key: "m", name: "monitor" },
		{ key: "A", name: "agents" },
		{ key: "R", name: "runs" },
		{ key: "a", name: "activity" },
	];
	for (const tab of tabs) {
		component.handleInput(tab.key);
		component.handleInput("g");
		const g = getDone();
		check(
			`${tab.name}: g resolves graph for the selected run`,
			g?.type === "graph" && g?.run?.runId === "SHARED",
			JSON.stringify(g),
		);
		component.handleInput("v");
		const v = getDone();
		check(
			`${tab.name}: v resolves view for the selected run`,
			v?.type === "view" && v?.run?.runId === "SHARED",
			JSON.stringify(v),
		);
		component.handleInput("d");
		const d = getDone();
		check(
			`${tab.name}: d resolves deleteRun for the selected run`,
			d?.type === "deleteRun" && d?.run?.runId === "SHARED",
			JSON.stringify(d),
		);
	}
}

async function scenarioKeyboardNav(url) {
	// P3: tecla directa para saltar a Runs, vim j/k + G, y Shift+Tab para la tab previa.
	const { component, getDone } = await openDashboardComponent(url);
	const runs = Array.from({ length: 5 }, (_, i) => ({
		runId: `r${i}`,
		workflow: "wf",
		runDir: `/tmp/r${i}`,
		agentCount: 0,
		background: true,
		scope: "project",
	}));
	component.setRuns(runs);

	component.handleInput("R"); // salta directo a Runs (la única tab sin letra antes)
	let txt = component.render(100).join("\n");
	check("R jumps to the Runs tab", txt.includes("[Runs]"), txt.split("\n")[0]);

	component.handleInput("j"); // vim down -> índice 1
	component.handleInput("j"); // -> índice 2
	component.handleInput("k"); // vim up -> índice 1
	component.handleInput("v");
	check("j/k navigate the list (vim down/up)", getDone()?.run?.runId === "r1", JSON.stringify(getDone()));

	component.handleInput("G"); // salta al último
	component.handleInput("v");
	check("G jumps to the last item", getDone()?.run?.runId === "r4", JSON.stringify(getDone()));

	component.handleInput("shift+tab"); // tab previa: runs -> sessions
	txt = component.render(100).join("\n");
	check("Shift+Tab cycles to the previous tab", txt.includes("[Sessions]"), txt.split("\n")[0]);
}

async function scenarioLiveAgentHeaderStatus(url) {
	// El visor live de agente antes hardcodeaba 'refresh 1s' en su header incluso después de que
	// el agente terminara (y seguía polleando). El label del header debe reflejar el estado.
	const mod = await import(url);
	const fn = mod.liveAgentHeaderStatus;
	check("liveAgentHeaderStatus is exported", typeof fn === "function", String(typeof fn));
	if (typeof fn !== "function") return;
	check("running agent live header advertises 'refresh 1s'", fn("running") === "refresh 1s", String(fn("running")));
	check(
		"unknown/undefined state keeps the polling label",
		fn(undefined) === "refresh 1s" && fn("unknown") === "refresh 1s",
		`${fn(undefined)} | ${fn("unknown")}`,
	);
	check(
		"completed agent live header shows 'final', not 'refresh 1s'",
		fn("completed") === "final (completed)",
		String(fn("completed")),
	);
	check("failed agent live header shows 'final'", fn("failed") === "final (failed)", String(fn("failed")));
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
	await scenarioReopenAfterAction(url);
	await scenarioHelpOverlay(url);
	await scenarioRunningAgentLiveElapsed(url);
	await scenarioRefreshFreshnessAndErrors(url);
	await scenarioAgentsJumpToFailed(url);
	await scenarioMonitorMultiRun(url);
	await scenarioMonitorHelpGating(url);
	await scenarioLiveAgentHeaderStatus(url);
	await scenarioKeyboardNav(url);
	await scenarioRunActionsConsistentAcrossTabs(url);
	await scenarioListWindowIndicator(url);
	await scenarioEllipsisOnOverflow(url);

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
