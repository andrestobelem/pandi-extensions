#!/usr/bin/env node
/**
 * Test de comportamiento para el shortcut cleanup del dashboard: `C` emite una acción "cleanup"
 * scopeada al tab actual — sessions en el tab Sessions, runs en cualquier tab con runs.
 *
 * El comando `/workflow cleanup` ya existe; esto cablea la misma intención en la TUI
 * para que una persona navegando los tabs Sessions/Runs pueda disparar el prune desde donde ve la
 * basura. `C` (mayúscula) se elige para que nunca colisione con `c`/`x` = cancel en tabs de runs.
 *
 * Contrato observable (este test):
 *   - Sessions tab + `C` → done({ type: "cleanup", cleanupTarget: "sessions" }).
 *   - Runs tab + `C`     → done({ type: "cleanup", cleanupTarget: "runs" }).
 *   - `c` minúscula en el tab Runs todavía significa cancel (nunca cleanup).
 *
 * Refleja dashboard-jump-active-run.test.mjs: build de la extensión, abre el componente dashboard
 * por el comando /workflow, y alimenta handleInput con un done capturador.
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
		name: "pi-dwf-cleanup-key",
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
	return { mod, ext: mod.default };
}

function makePi() {
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		events: { on: () => {} },
		registerTool: () => {},
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, commands, handlers };
}

function makeCtx(cwd) {
	const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
	return {
		mode: "tui",
		hasUI: true,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, initial = "") => initial,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
			custom: async () => null,
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "sid",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "s.jsonl"),
			getSessionName: () => "Test",
		},
	};
}

async function openComponent(url) {
	const { mod, ext } = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-cleanup-key-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	const ctx = makeCtx(project);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	let captured = null;
	const done = (result) => {
		captured = result;
	};
	ctx.ui.custom = async (factory) => {
		const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
		captured = { component: factory(tui, ctx.ui.theme, {}, done) };
		return null;
	};
	await commands.get("workflow").handler("dashboard", ctx);
	const component = captured.component;
	// Reseteá captured para que el primer done() posterior sea lo que asertamos.
	captured = null;
	return { component, getCaptured: () => captured, mod };
}

const mkRun = (runId, state) => ({
	runId,
	workflow: "wf",
	runDir: `/tmp/${runId}`,
	agentCount: 0,
	background: true,
	scope: "project",
	state,
});
const mkSession = (id) => ({
	id,
	pid: 1,
	mode: "tui",
	cwd: "/x",
	startedAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	file: `/x/${id}.json`,
	live: false,
	current: false,
	ageMs: 999999,
	staleReason: "pid exited",
});

async function main() {
	const { url } = await buildExtension();

	// 1) Tab Sessions + C → cleanup sessions.
	{
		const { component, getCaptured } = await openComponent(url);
		component.setPiSessions([mkSession("s1"), mkSession("s2")]);
		component.handleInput("s"); // → tab sessions
		component.handleInput("C");
		const c = getCaptured();
		check(
			"Sessions + C → cleanup/sessions",
			c && c.type === "cleanup" && c.cleanupTarget === "sessions",
			JSON.stringify(c),
		);
	}

	// 2) Tab Runs + C → cleanup runs.
	{
		const { component, getCaptured } = await openComponent(url);
		component.setRuns([mkRun("r0", "completed"), mkRun("r1", "failed")]);
		component.handleInput("R"); // → tab runs
		component.handleInput("C");
		const c = getCaptured();
		check("Runs + C → cleanup/runs", c && c.type === "cleanup" && c.cleanupTarget === "runs", JSON.stringify(c));
	}

	// 3) c minúscula en tab Runs sigue siendo semántica cancel, nunca cleanup.
	{
		const { component, getCaptured, mod } = await openComponent(url);
		component.setRuns([mkRun("r1", "running")]);
		mod.registerActiveRun({ runId: "r1" });
		try {
			component.handleInput("R");
			component.handleInput("c"); // cancel (gateado por canCancelRun para un run bg running)
			const c = getCaptured();
			check("Runs + c → cancel/r1", c && c.type === "cancel" && c.run?.runId === "r1", JSON.stringify(c));
		} finally {
			mod.clearActiveRuns();
		}
	}

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
