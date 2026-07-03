#!/usr/bin/env node
/**
 * Behavioral regression test for actionable empty states on the workflow dashboard.
 *
 * Observable contract: every empty run-bearing tab (Monitor, Runs, Agents, Activity)
 * tells a first-time user the EXACT command to create the missing artifact, instead of
 * a dead-end "nothing here" line. Before this fix, Runs / Agents / Activity rendered no
 * "/workflow start" guidance, so the user had no concrete next step from those tabs.
 *
 * This is distinct from `dashboard-usability-fixes.test.mjs`, which only asserts the
 * idle *status bar* advertises the entrypoint; here we assert the empty *tab bodies*.
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
		name: "pi-dwf-empty-state-guidance",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
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

function makeCtx(cwd) {
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
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
			// Overridden in openComponent() to capture the live component handle.
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-empty-state-"));
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
	// Capture the live component handle so the test can drive handleInput directly.
	let captured = null;
	ctx.ui.custom = async (factory) => {
		const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
		captured = factory(tui, ctx.ui.theme, {}, () => {});
		return null;
	};
	await commands.get("workflow").handler("dashboard", ctx);
	return captured;
}

function tabBody(component) {
	return component.render(100).join("\n");
}

async function main() {
	const { url } = await buildExtension();
	const HINT = "/workflow start";
	const component = await openComponent(url);

	// Monitor (default tab) on an empty project: keeps the existing guidance.
	const monitor = tabBody(component);
	check(
		"empty Monitor advertises the /workflow start command",
		monitor.includes("[Monitor]") && monitor.includes(HINT),
		monitor.split("\n").slice(0, 6).join(" | "),
	);

	// Runs tab: used to render a bare "No workflow runs found." with no next step.
	component.handleInput("R");
	const runs = tabBody(component);
	check("Runs tab is empty as expected", runs.includes("No workflow runs found."), runs.split("\n")[0]);
	check(
		"empty Runs tab advertises the /workflow start command",
		runs.includes(HINT),
		runs.split("\n").slice(0, 6).join(" | "),
	);

	// Agents tab: used to describe but never give the exact command.
	component.handleInput("A");
	const agents = tabBody(component);
	check("Agents tab is empty as expected", agents.includes("No workflow agents found yet."), agents.split("\n")[0]);
	check(
		"empty Agents tab advertises the /workflow start command",
		agents.includes(HINT),
		agents.split("\n").slice(0, 6).join(" | "),
	);

	// Activity tab: used to render "No workflow activity yet." with no next step.
	component.handleInput("a");
	const activity = tabBody(component);
	check("Activity tab is empty as expected", activity.includes("No workflow activity yet."), activity.split("\n")[0]);
	check(
		"empty Activity tab advertises the /workflow start command",
		activity.includes(HINT),
		activity.split("\n").slice(0, 8).join(" | "),
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
