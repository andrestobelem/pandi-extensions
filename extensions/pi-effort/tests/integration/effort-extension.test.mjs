#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-effort/index.ts.
 *
 * Pins the public /effort contract:
 * - named levels call pi.setThinkingLevel and report the active clamped level
 * - aliases such as `none` and `thinking=max` map to Pi thinking levels
 * - no-arg TUI usage opens a selector
 * - `ultracode` sets xhigh, activates dynamic_workflow when present, and emits the
 *   inter-extension event consumed by dynamic-workflows.ts
 * - thinking_level_select keeps the status line in sync
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

async function buildEffort() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-effort-integration-"));
	const src = path.join(REPO_ROOT, "extensions", "pi-effort", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "effort.mjs");
	const r = spawnSync(
		"npx",
		[
			"--yes",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed for effort: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

let instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi({ initialLevel = "medium", allTools = [], activeTools = [], clamp } = {}) {
	let level = initialLevel;
	let active = [...activeTools];
	const commands = new Map();
	const handlers = new Map();
	const emitted = [];
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		getThinkingLevel: () => level,
		setThinkingLevel: (next) => {
			level = clamp ? clamp(next) : next;
		},
		getActiveTools: () => [...active],
		getAllTools: () => allTools.map((name) => ({ name })),
		setActiveTools: (names) => {
			active = [...names];
		},
		events: {
			emit: (event, data) => emitted.push({ event, data }),
		},
	};
	return { pi, commands, handlers, emitted, get level() { return level; }, get activeTools() { return active; } };
}

function makeCtx({ mode = "tui", hasUI = true, selectResult } = {}) {
	const notes = [];
	const statuses = [];
	const ctx = {
		mode,
		hasUI,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: (key, value) => statuses.push({ key, value }),
			select: async () => selectResult,
		},
	};
	ctx._notes = notes;
	ctx._statuses = statuses;
	return ctx;
}

async function fire(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) || []) await handler(payload, ctx);
}

async function scenarioLevels(url) {
	const effortExtension = await freshDefault(url);
	const harness = makePi();
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	check("/effort command registered", !!command);
	const allCompletions = command.getArgumentCompletions("");
	check("/effort has completions", Array.isArray(command.getArgumentCompletions("h")));
	check("/effort autocomplete includes canonical levels", ["off", "minimal", "low", "medium", "high", "xhigh", "ultracode", "status"].every((value) => allCompletions.some((item) => item.value === value)));
	check("/effort autocomplete includes max alias", command.getArgumentCompletions("ma")?.some((item) => item.value === "max"));
	check("/effort autocomplete includes ultra-code alias", command.getArgumentCompletions("ultra-")?.some((item) => item.value === "ultra-code"));

	const ctx = makeCtx();
	await command.handler("high", ctx);
	check("/effort high sets high", harness.level === "high", harness.level);
	check("/effort high notifies", ctx._notes.some((n) => /set to high/i.test(n.msg)));
	check("/effort high updates status", ctx._statuses.some((s) => s.key === "effort" && s.value === "effort:high"));

	await command.handler("none", ctx);
	check("/effort none aliases off", harness.level === "off", harness.level);

	await command.handler("thinking=max", ctx);
	check("/effort thinking=max aliases xhigh", harness.level === "xhigh", harness.level);
}

async function scenarioClampAndInvalid(url) {
	const effortExtension = await freshDefault(url);
	const harness = makePi({ initialLevel: "medium", clamp: (next) => (next === "xhigh" ? "high" : next) });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("xhigh", ctx);
	check("/effort reports clamped active level", harness.level === "high", harness.level);
	check("/effort clamp warning", ctx._notes.some((n) => n.type === "warning" && /active effort is high/i.test(n.msg)));

	const before = harness.level;
	await command.handler("banana", ctx);
	check("/effort invalid does not change level", harness.level === before, `${before} -> ${harness.level}`);
	check("/effort invalid shows usage", ctx._notes.some((n) => /Unknown effort/i.test(n.msg) && /Usage: \/effort/.test(n.msg)));
}

async function scenarioSelectorAndStatusEvent(url) {
	const effortExtension = await freshDefault(url);
	const harness = makePi({ initialLevel: "medium" });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx({ selectResult: "low — low thinking" });

	await command.handler("", ctx);
	check("/effort no args uses selector choice", harness.level === "low", harness.level);

	await fire(harness.handlers, "thinking_level_select", { level: "minimal", previousLevel: "low" }, ctx);
	check("thinking_level_select refreshes status", ctx._statuses.some((s) => s.key === "effort" && s.value === "effort:minimal"));

	await command.handler("status", ctx);
	check("/effort status reports current", ctx._notes.some((n) => /Current effort: low/i.test(n.msg)));
}

async function scenarioUltracode(url) {
	const effortExtension = await freshDefault(url);
	const harness = makePi({ allTools: ["read", "dynamic_workflow"], activeTools: ["read"] });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("ultracode", ctx);
	check("/effort ultracode sets xhigh", harness.level === "xhigh", harness.level);
	check("/effort ultracode activates dynamic_workflow", harness.activeTools.includes("dynamic_workflow"), harness.activeTools.join(","));
	check(
		"/effort ultracode emits router event",
		harness.emitted.some((e) => e.event === "pi-dynamic-workflows:ultracode-mode" && e.data?.enabled === true && e.data?.source === "/effort"),
		JSON.stringify(harness.emitted),
	);
	check("/effort ultracode notifies", ctx._notes.some((n) => /Ultracode effort enabled/i.test(n.msg)));
}

async function main() {
	const { outDir, url } = await buildEffort();
	try {
		await scenarioLevels(url);
		await scenarioClampAndInvalid(url);
		await scenarioSelectorAndStatusEvent(url);
		await scenarioUltracode(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed) {
		console.log("Failures:");
		for (const failure of failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
