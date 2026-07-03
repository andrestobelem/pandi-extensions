#!/usr/bin/env node
/**
 * Behavioral test: bare `/ultracode-mode` (no argument) opens an interactive
 * selector when the session has a UI, letting the user pick on|off|status.
 *
 * Observable contract:
 *   - `/ultracode-mode` with no args + hasUI  → calls ctx.ui.select once with the
 *     on/off/status options, and applies the chosen value (picking "on" enables
 *     always-on routing → an "enabled" notification).
 *   - Headless (no UI, e.g. print mode) NEVER opens the selector; behavior is the
 *     unchanged bare = "status" path (no regression).
 *   - Passing an explicit argument (`/ultracode-mode off`) still bypasses the
 *     selector entirely.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-ultracode-mode-selector",
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
	const activeTools = [];
	const pi = {
		events: { on: () => {}, emit: () => {} },
		registerTool: (def) => tools.set(def.name, def),
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
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, commands };
}

function makeCtx({ mode = "tui", hasUI = true, selectResult } = {}) {
	const notifies = [];
	const selectCalls = [];
	const ctx = {
		mode,
		hasUI,
		cwd: "/tmp",
		isIdle: () => true,
		ui: {
			theme: { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v },
			notify: (message, type) => notifies.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async (title, items) => {
				selectCalls.push({ title, items });
				return selectResult;
			},
		},
	};
	return { ctx, notifies, selectCalls };
}

async function loadCommand(url) {
	const ext = await freshExtension(url);
	const { pi, commands } = makePi();
	ext(pi);
	const cmd = commands.get("ultracode-mode");
	if (!cmd) throw new Error("ultracode-mode command was not registered");
	return cmd;
}

async function scenarioBareWithUiOpensSelectorAndApplies(url) {
	const cmd = await loadCommand(url);
	const { ctx, notifies, selectCalls } = makeCtx({ selectResult: "on" });
	await cmd.handler("", ctx);

	check("bare + UI calls the selector exactly once", selectCalls.length === 1, `calls=${selectCalls.length}`);
	const items = selectCalls[0]?.items ?? [];
	const has = (v) => items.some((i) => String(i).toLowerCase().startsWith(v));
	check("selector offers on / off / status", has("on") && has("off") && has("status"), JSON.stringify(items));
	// The ON branch emits a message the status branch never does — proves the chosen
	// value was actually applied, not that a default status readout happened to say "enabled".
	const appliedOn = notifies.some((n) => /evaluate each task/i.test(n.message));
	check("picking 'on' applies the on branch", appliedOn, JSON.stringify(notifies));
}

async function scenarioHeadlessNeverOpensSelector(url) {
	const cmd = await loadCommand(url);
	const { ctx, selectCalls } = makeCtx({ mode: "print", hasUI: false, selectResult: "on" });
	await cmd.handler("", ctx);
	check("headless bare never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
}

async function scenarioExplicitArgBypassesSelector(url) {
	const cmd = await loadCommand(url);
	const { ctx, selectCalls } = makeCtx({ selectResult: "on" });
	await cmd.handler("off", ctx);
	check("explicit arg bypasses the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
}

async function main() {
	const { url } = await buildExtension();
	await scenarioBareWithUiOpensSelectorAndApplies(url);
	await scenarioHeadlessNeverOpensSelector(url);
	await scenarioExplicitArgBypassesSelector(url);

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
