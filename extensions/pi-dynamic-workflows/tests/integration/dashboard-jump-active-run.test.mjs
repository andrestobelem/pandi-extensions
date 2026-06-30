#!/usr/bin/env node
/**
 * Behavioral regression test for DW-DASH-H3: a one-key jump to the next/previous
 * RUNNING run on the flat lists (Runs and Activity tabs), via `]` / `[`.
 *
 * Observable contract:
 *   - On the Runs tab, `]` advances selection to the next run whose state is "running"
 *     (wrapping), and `[` goes to the previous one; completed/failed runs are skipped.
 *   - On the Activity tab, `]` / `[` jump between entries whose state is "running".
 *   - With nothing running, the keys are a no-op (selection unchanged).
 * This mirrors the Monitor's existing `[` / `]` run cycling and the Agents tab's `f`
 * (next failed agent), giving long lists one-key triage to the in-progress items.
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
		name: "pi-dwf-jump-active-run",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
		npx: "--yes",
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

function makeCtx(cwd) {
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
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
			custom: async () => null,
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "test-session-id",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "test-session.jsonl"),
			getSessionName: () => "Test session",
		},
	};
	return { ctx };
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-jump-active-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function openComponent(url) {
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const project = await makeProject();
	const { ctx } = makeCtx(project);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	let captured = null;
	ctx.ui.custom = async (factory) => {
		const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
		captured = factory(tui, ctx.ui.theme, {}, () => {});
		return null;
	};
	await commands.get("workflow").handler("dashboard", ctx);
	return captured;
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

const mkActivity = (runId, state) => ({
	runId,
	workflow: "wf",
	time: new Date().toISOString(),
	message: "msg",
	state,
});

async function main() {
	const { url } = await buildExtension();
	const component = await openComponent(url);

	// Runs tab: [completed, running, completed, running], cursor starts at 0.
	component.setRuns([
		mkRun("r0", "completed"),
		mkRun("r1", "running"),
		mkRun("r2", "completed"),
		mkRun("r3", "running"),
	]);
	component.handleInput("R"); // jump to Runs tab
	check("Runs: starts at index 0", component.getSelection().runIndex === 0, String(component.getSelection().runIndex));

	component.handleInput("]"); // -> next running after 0 => r1 (index 1)
	check(
		"Runs: ] skips completed r0 to running r1",
		component.getSelection().runIndex === 1,
		String(component.getSelection().runIndex),
	);

	component.handleInput("]"); // -> next running after 1 => r3 (index 3)
	check(
		"Runs: ] skips completed r2 to running r3",
		component.getSelection().runIndex === 3,
		String(component.getSelection().runIndex),
	);

	component.handleInput("]"); // wraps -> r1 (index 1)
	check(
		"Runs: ] wraps from last running back to first",
		component.getSelection().runIndex === 1,
		String(component.getSelection().runIndex),
	);

	component.handleInput("["); // previous running from 1 => wraps to r3 (index 3)
	check(
		"Runs: [ goes to previous running, wrapping",
		component.getSelection().runIndex === 3,
		String(component.getSelection().runIndex),
	);

	// No running runs: keys are a no-op.
	component.setRuns([mkRun("a", "completed"), mkRun("b", "failed"), mkRun("c", "completed")]);
	component.handleInput("R");
	const before = component.getSelection().runIndex;
	component.handleInput("]");
	check(
		"Runs: ] is a no-op when nothing is running",
		component.getSelection().runIndex === before,
		`${before} -> ${component.getSelection().runIndex}`,
	);

	// Activity tab: jump between running entries.
	component.setActivity([mkActivity("a0", "completed"), mkActivity("a1", "running"), mkActivity("a2", "completed")]);
	component.handleInput("a"); // Activity tab
	check(
		"Activity: starts at index 0",
		component.getSelection().activityIndex === 0,
		String(component.getSelection().activityIndex),
	);
	component.handleInput("]"); // -> running a1 (index 1)
	check(
		"Activity: ] jumps to the running entry",
		component.getSelection().activityIndex === 1,
		String(component.getSelection().activityIndex),
	);

	// Help advertises the new shortcut.
	component.handleInput("?");
	const help = component.render(100).join("\n");
	check(
		"Help overlay documents the [ ] running-run jump",
		/\[ \].*running/i.test(help),
		help.split("\n").find((l) => l.includes("[ ]")) || "(not found)",
	);

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
