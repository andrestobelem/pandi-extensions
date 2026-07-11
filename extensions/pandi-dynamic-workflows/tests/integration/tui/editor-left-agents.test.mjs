#!/usr/bin/env node
/**
 * Behavioral regression test for the editor-boundary workflow dashboard shortcuts.
 *
 * Observable contract:
 *   - Down at the bottom of the prompt still opens the workflow dashboard on Monitor.
 *   - Left at the left edge of the prompt opens the same dashboard directly on Sessions.
 *   - Left that actually moves the editor cursor does NOT open the dashboard.
 *   - /workflow agents is still a slash-command fallback for the Agents tab.
 *   - /workflow sessions opens the live Pi sessions tab.
 *   - Enter on a selected Pi session switches to that session file from both
 *     slash-command and editor-opened dashboards.
 *   - Right on a selected Pi session switches directly without confirmation.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dwf-editor-shortcuts", customEditor: "full" });
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
	const activeTools = [];
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
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, handlers, shortcuts };
}

function makeBaseEditor({ text = "", cursor = { line: 0, col: 0 }, moveOnLeft = false, autocomplete = false } = {}) {
	const handledInputs = [];
	return {
		actionHandlers: new Map(),
		focused: false,
		getText: () => text,
		setText: (next) => {
			text = next;
		},
		handleInput: (data) => {
			handledInputs.push(data);
			if (moveOnLeft && data === "left") cursor = { ...cursor, col: Math.max(0, cursor.col - 1) };
		},
		render: () => ["editor"],
		invalidate: () => {},
		getCursor: () => ({ ...cursor }),
		isShowingAutocomplete: () => autocomplete,
		addToHistory: () => {},
		insertTextAtCursor: (value) => {
			text = text.slice(0, cursor.col) + value + text.slice(cursor.col);
			cursor = { ...cursor, col: cursor.col + value.length };
		},
		getExpandedText: () => text,
		setAutocompleteProvider: () => {},
		setPaddingX: () => {},
		setAutocompleteMaxVisible: () => {},
		handledInputs,
	};
}

function makeCtx(cwd, baseFactory, opts = {}) {
	let editorFactory;
	const customCalls = [];
	const switchCalls = [];
	const confirmCalls = [];
	const customInputs = [...(opts.customInputs ?? [])];
	let renderRequests = 0;
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
			confirm: async (title, message) => {
				confirmCalls.push({ title, message });
				return opts.confirmResult ?? true;
			},
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			getEditorComponent: () => baseFactory,
			setEditorComponent: (factory) => {
				editorFactory = factory;
			},
			custom: async (factory) => {
				const tui = {
					terminal: { rows: 30, columns: 100 },
					requestRender: () => {
						renderRequests += 1;
					},
				};
				let doneValue;
				const component = factory(tui, theme, {}, (value) => {
					doneValue = value;
				});
				while (customInputs.length > 0 && typeof component?.handleInput === "function")
					component.handleInput(customInputs.shift());
				const lines = typeof component?.render === "function" ? component.render(100) : [];
				customCalls.push({ component, lines, doneValue });
				return doneValue ?? null;
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
	if (opts.includeSwitchSession !== false) {
		ctx.switchSession = async (sessionPath, options = {}) => {
			switchCalls.push({ sessionPath, options });
			if (typeof options.withSession === "function") await options.withSession(ctx);
			return { cancelled: false };
		};
	}
	return {
		ctx,
		customCalls,
		switchCalls,
		confirmCalls,
		getEditorFactory: () => editorFactory,
		getRenderRequests: () => renderRequests,
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-editor-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function seedOtherPiSession(project) {
	const sessionFile = path.join(project, ".pi", "sessions", "other-session.jsonl");
	await fs.mkdir(path.dirname(sessionFile), { recursive: true });
	await fs.writeFile(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			id: "other-session-id",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: project,
		})}\n`,
	);
	const liveRoot = path.join(project, ".pi", "live-sessions");
	await fs.mkdir(liveRoot, { recursive: true });
	const now = new Date().toISOString();
	await fs.writeFile(
		path.join(liveRoot, "other.json"),
		JSON.stringify(
			{
				id: "other-runtime",
				pid: process.pid,
				mode: "tui",
				cwd: project,
				startedAt: now,
				updatedAt: now,
				sessionId: "other-session-id",
				sessionFile,
				sessionName: "Other session",
				trusted: true,
				idle: true,
				activeWorkflowRuns: 0,
			},
			null,
			2,
		),
	);
	return sessionFile;
}

async function installEditor(url, baseEditor) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, () => baseEditor);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, state.ctx);
	}
	const editorFactory = state.getEditorFactory();
	if (typeof editorFactory !== "function") throw new Error("session_start did not install an editor factory");
	const wrapped = editorFactory(
		{ requestRender: () => {}, terminal: { rows: 30, columns: 100 } },
		state.ctx.ui.theme,
		{},
	);
	return { ...state, commands, wrapped };
}

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

function renderedText(call) {
	return (call?.lines ?? []).join("\n");
}

async function scenarioLeftOpensSessions(url) {
	const { wrapped, customCalls } = await installEditor(url, makeBaseEditor({ cursor: { line: 0, col: 0 } }));
	wrapped.handleInput("left");
	await waitFor(() => customCalls.length === 1);
	const text = renderedText(customCalls[0]);
	check("left boundary opens dashboard", customCalls.length === 1, `calls=${customCalls.length}`);
	check("left boundary opens Sessions tab", text.includes("[Sessions]"), text.split("\n")[0]);
	check("left boundary does not open Monitor tab", !text.includes("[Monitor]"), text.split("\n")[0]);
	check("left boundary does not open Agents tab", !text.includes("[Agents]"), text.split("\n")[0]);
}

async function scenarioDownStillOpensMonitor(url) {
	const { wrapped, customCalls } = await installEditor(url, makeBaseEditor({ cursor: { line: 0, col: 0 } }));
	wrapped.handleInput("down");
	await waitFor(() => customCalls.length === 1);
	const text = renderedText(customCalls[0]);
	check("down boundary still opens dashboard", customCalls.length === 1, `calls=${customCalls.length}`);
	check("down boundary opens Monitor tab", text.includes("[Monitor]"), text.split("\n")[0]);
}

async function scenarioLeftMovementDoesNotOpen(url) {
	const base = makeBaseEditor({ cursor: { line: 0, col: 1 }, moveOnLeft: true });
	const { wrapped, customCalls } = await installEditor(url, base);
	wrapped.handleInput("left");
	await new Promise((resolve) => setTimeout(resolve, 50));
	check(
		"left that moves cursor is delegated to editor",
		base.handledInputs.includes("left"),
		JSON.stringify(base.handledInputs),
	);
	check("left that moves cursor does not open dashboard", customCalls.length === 0, `calls=${customCalls.length}`);
}

async function scenarioLeftWithTextDoesNotOpen(url) {
	// A composed prompt with the cursor at col 0: ← must stay a normal editor key,
	// not surprise-open the Sessions dashboard (the gesture is for an EMPTY editor).
	const base = makeBaseEditor({ text: "hello world", cursor: { line: 0, col: 0 } });
	const { wrapped, customCalls } = await installEditor(url, base);
	wrapped.handleInput("left");
	await new Promise((resolve) => setTimeout(resolve, 50));
	check(
		"left with a non-empty prompt does not open the dashboard",
		customCalls.length === 0,
		`calls=${customCalls.length}`,
	);
	check(
		"left with a non-empty prompt is delegated to the editor",
		base.handledInputs.includes("left"),
		JSON.stringify(base.handledInputs),
	);
}

async function scenarioWorkflowAgentsCommand(url) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, () => makeBaseEditor());
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, state.ctx);
	await commands.get("workflow").handler("agents", state.ctx);
	const text = renderedText(state.customCalls[0]);
	check("/workflow agents opens dashboard", state.customCalls.length === 1, `calls=${state.customCalls.length}`);
	check("/workflow agents opens Agents tab", text.includes("[Agents]"), text.split("\n")[0]);
}

async function scenarioWorkflowSessionsCommand(url) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, () => makeBaseEditor());
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, state.ctx);
	await commands.get("workflow").handler("sessions", state.ctx);
	const text = renderedText(state.customCalls[0]);
	check("/workflow sessions opens dashboard", state.customCalls.length === 1, `calls=${state.customCalls.length}`);
	check("/workflow sessions opens Sessions tab", text.includes("[Sessions]"), text.split("\n")[0]);
	check(
		"/workflow sessions shows current live Pi session",
		text.includes("test-session-id") && text.includes("this process"),
		text,
	);
}

async function scenarioWorkflowSessionsEnterSwitches(url) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, () => makeBaseEditor(), { customInputs: ["down", "enter"] });
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, state.ctx);

	const sessionFile = await seedOtherPiSession(project);

	await commands.get("workflow").handler("sessions", state.ctx);
	check("Enter on Sessions tab switches once", state.switchCalls.length === 1, `calls=${state.switchCalls.length}`);
	check(
		"Enter on selected Pi session switches to its session file",
		state.switchCalls[0]?.sessionPath === sessionFile,
		`path=${state.switchCalls[0]?.sessionPath}`,
	);
}

async function scenarioWorkflowSessionsRightSwitchesDirectly(url) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, () => makeBaseEditor(), {
		customInputs: ["down", "right"],
		confirmResult: false,
	});
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, state.ctx);

	const sessionFile = await seedOtherPiSession(project);

	await commands.get("workflow").handler("sessions", state.ctx);
	check("Right on Sessions tab switches once", state.switchCalls.length === 1, `calls=${state.switchCalls.length}`);
	check(
		"Right on selected Pi session switches to its session file",
		state.switchCalls[0]?.sessionPath === sessionFile,
		`path=${state.switchCalls[0]?.sessionPath}`,
	);
	check(
		"Right on selected Pi session does not ask for confirmation",
		state.confirmCalls.length === 0,
		`confirm calls=${state.confirmCalls.length}`,
	);
}

async function scenarioEditorOpenedSessionsEnterSwitches(url) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const base = makeBaseEditor({ cursor: { line: 0, col: 0 } });
	const eventState = makeCtx(project, () => base, {
		customInputs: ["down", "enter"],
		includeSwitchSession: false,
	});
	const commandState = makeCtx(project, () => base);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, eventState.ctx);
	const sessionFile = await seedOtherPiSession(project);
	const editorFactory = eventState.getEditorFactory();
	if (typeof editorFactory !== "function") throw new Error("session_start did not install an editor factory");
	const wrapped = editorFactory(
		{ requestRender: () => {}, terminal: { rows: 30, columns: 100 } },
		eventState.ctx.ui.theme,
		{},
	);
	wrapped.onSubmit = async (text) => {
		const prefix = "/workflow ";
		if (!text.startsWith(prefix)) throw new Error(`unexpected submitted command: ${text}`);
		await commands.get("workflow").handler(text.slice(prefix.length), commandState.ctx);
	};

	wrapped.handleInput("left");
	await waitFor(() => commandState.switchCalls.length === 1);
	check(
		"Enter from editor-opened Sessions dashboard submits switch command",
		commandState.switchCalls.length === 1,
		`calls=${commandState.switchCalls.length}`,
	);
	check(
		"Editor-opened Sessions dashboard switches to selected session file",
		commandState.switchCalls[0]?.sessionPath === sessionFile,
		`path=${commandState.switchCalls[0]?.sessionPath}`,
	);
}

async function main() {
	const { url } = await buildExtension();
	await scenarioLeftOpensSessions(url);
	await scenarioDownStillOpensMonitor(url);
	await scenarioLeftMovementDoesNotOpen(url);
	await scenarioLeftWithTextDoesNotOpen(url);
	await scenarioWorkflowAgentsCommand(url);
	await scenarioWorkflowSessionsCommand(url);
	await scenarioWorkflowSessionsEnterSwitches(url);
	await scenarioWorkflowSessionsRightSwitchesDirectly(url);
	await scenarioEditorOpenedSessionsEnterSwitches(url);

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
