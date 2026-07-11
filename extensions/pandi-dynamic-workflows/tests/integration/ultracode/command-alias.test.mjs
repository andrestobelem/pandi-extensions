#!/usr/bin/env node
/**
 * Behavioral contract: the extension registers a `/ultracode` SLASH COMMAND that is a
 * faithful alias of `/dynamic-workflow`.
 *
 * Why this exists: users type `/ultracode <task>` and expect it to autocomplete like any
 * other command. Before this, the word "ultracode" only triggered via a plain-text input
 * transform (`extractUltracodeTask`) — there was no registered command, so the palette never
 * offered it. This pins that:
 *   - `/ultracode` is registered (so it autocompletes) with a non-empty description.
 *   - With a task, it sends the SAME workflow prompt as `/dynamic-workflow <task>` (true alias).
 *   - With no task, it guards usage (notifies) and sends nothing — never a blank run.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?uca=${instance++}`);
	return mod.default;
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const activeTools = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: (text, opts) => sentMessages.push({ text, opts }),
		getThinkingLevel: () => undefined,
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => activeTools.splice(0, activeTools.length, ...next),
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, handlers, sentMessages };
}

function makeCtx({ interactive = false } = {}) {
	const notifications = [];
	const theme = { fg: (_c, v) => v };
	const ctx = {
		// `notify` only routes to ui.notify off print-mode with a UI; print-mode console.logs.
		mode: interactive ? "interactive" : "print",
		hasUI: interactive,
		cwd: REPO_ROOT,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
	return { ctx, notifications };
}

async function main() {
	const { url } = await buildDwfExtension({ name: "pi-dwf-ultracode-alias" });

	const ext = await freshExtension(url);
	const { pi, commands } = makePi();
	ext(pi);

	// 1. Registered → autocompletes in the palette.
	check("/ultracode is a registered command", commands.has("ultracode"), [...commands.keys()].join(", "));
	const cmd = commands.get("ultracode");
	check(
		"/ultracode has a non-empty description",
		typeof cmd?.description === "string" && cmd.description.trim().length > 0,
		JSON.stringify(cmd?.description),
	);

	// 2. With a task → sends the SAME prompt as /dynamic-workflow (faithful alias).
	// Isolate each command in its own freshly-activated extension + pi so the two
	// sendUserMessage streams don't interleave.
	const task = "audit the repo for concurrency bugs";
	const a = makePi();
	const bExt = await freshExtension(url);
	bExt(a.pi);
	await a.commands.get("ultracode").handler(task, makeCtx().ctx);
	const b = makePi();
	const cExt = await freshExtension(url);
	cExt(b.pi);
	await b.commands.get("dynamic-workflow").handler(task, makeCtx().ctx);

	check("/ultracode sends exactly one prompt", a.sentMessages.length === 1, JSON.stringify(a.sentMessages));
	check("/dynamic-workflow sends exactly one prompt", b.sentMessages.length === 1, JSON.stringify(b.sentMessages));
	check(
		"/ultracode prompt is byte-identical to /dynamic-workflow (true alias)",
		a.sentMessages[0]?.text === b.sentMessages[0]?.text,
		`ultracode=${JSON.stringify(a.sentMessages[0]?.text?.slice(0, 80))} dwf=${JSON.stringify(b.sentMessages[0]?.text?.slice(0, 80))}`,
	);
	check(
		"/ultracode prompt embeds the task",
		typeof a.sentMessages[0]?.text === "string" && a.sentMessages[0].text.includes(task),
		JSON.stringify(a.sentMessages[0]?.text?.slice(0, 120)),
	);

	// 3. With no task → guards usage, sends nothing.
	const g = makePi();
	const gExt = await freshExtension(url);
	gExt(g.pi);
	const guardCtx = makeCtx({ interactive: true });
	await g.commands.get("ultracode").handler("   ", guardCtx.ctx);
	check("/ultracode with empty task sends no message", g.sentMessages.length === 0, JSON.stringify(g.sentMessages));
	check(
		"/ultracode with empty task notifies usage",
		guardCtx.notifications.some((n) => /usage|uso/i.test(n.message)),
		JSON.stringify(guardCtx.notifications),
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
