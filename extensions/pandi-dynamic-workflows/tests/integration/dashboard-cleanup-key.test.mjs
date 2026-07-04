#!/usr/bin/env node
/**
 * Behavioral test for the dashboard cleanup shortcut: `C` emits a "cleanup" action scoped
 * to the current tab — sessions on the Sessions tab, runs on any run-bearing tab.
 *
 * The command `/workflow cleanup` already exists; this wires the same intent into the TUI
 * so a user browsing the Sessions/Runs tabs can trigger the prune from where they see the
 * junk. `C` (capital) is chosen so it never collides with the run tabs' `c`/`x` = cancel.
 *
 * Observable contract (this test):
 *   - Sessions tab + `C` → done({ type: "cleanup", cleanupTarget: "sessions" }).
 *   - Runs tab + `C`     → done({ type: "cleanup", cleanupTarget: "runs" }).
 *   - Lowercase `c` on the Runs tab still means cancel (never cleanup).
 *
 * Mirrors dashboard-jump-active-run.test.mjs: builds the extension, opens the dashboard
 * component through the /workflow command, and feeds handleInput with a capturing done.
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
	return mod.default;
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
	const ext = await freshExtension(url);
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
	// Reset captured so the first done() after this is what we assert.
	captured = null;
	return { component, getCaptured: () => captured };
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

	// 1) Sessions tab + C → cleanup sessions.
	{
		const { component, getCaptured } = await openComponent(url);
		component.setPiSessions([mkSession("s1"), mkSession("s2")]);
		component.handleInput("s"); // → sessions tab
		component.handleInput("C");
		const c = getCaptured();
		check(
			"Sessions + C → cleanup/sessions",
			c && c.type === "cleanup" && c.cleanupTarget === "sessions",
			JSON.stringify(c),
		);
	}

	// 2) Runs tab + C → cleanup runs.
	{
		const { component, getCaptured } = await openComponent(url);
		component.setRuns([mkRun("r0", "completed"), mkRun("r1", "failed")]);
		component.handleInput("R"); // → runs tab
		component.handleInput("C");
		const c = getCaptured();
		check("Runs + C → cleanup/runs", c && c.type === "cleanup" && c.cleanupTarget === "runs", JSON.stringify(c));
	}

	// 3) Lowercase c on Runs tab is still cancel semantics, never cleanup.
	{
		const { component, getCaptured } = await openComponent(url);
		component.setRuns([mkRun("r1", "running")]);
		component.handleInput("R");
		component.handleInput("c"); // cancel (gated on canCancelRun for a running bg run)
		const c = getCaptured();
		check("Runs + c is not cleanup", c?.type !== "cleanup", JSON.stringify(c));
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
