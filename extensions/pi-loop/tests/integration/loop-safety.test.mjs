/**
 * Integration tests for the autopilot safety gate and loop_schedule clamp in
 * extensions/pi-loop/index.ts.
 *
 * These are not full Pi process integration test tests: they bundle the current extension into
 * a temp dir, load it with a mocked ExtensionAPI/ctx, and assert observable gate
 * behavior.
 *
 * Run it:
 *   node extensions/pi-loop/tests/integration/loop-safety.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadDefault, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/<extension>/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// Default mocked project cwd. main() points this at the temp build dir so loop
// sidecar writes never pollute the real repo's .pi/loops during tests.
let TEST_PROJECT_ROOT = REPO_ROOT;

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Build the current extensions to ESM in a temp dir, return import URLs.
// ---------------------------------------------------------------------------
async function buildExtensions(names) {
	// The exercised gate paths only need typebox for tool-schema declaration and the SDK
	// symbols for state-dir resolution — never validation. One shared outDir/stubs keeps
	// getAgentDir consistent across the bundled extensions.
	const { outDir, aliases } = await makeBuildDir("pi-safety-integration", {
		typebox: true,
		sdk: (dir) => sdkStub(dir),
	});
	const urls = {};
	for (const name of names) {
		const packageDir = name.startsWith("pi-") ? name : `pi-${name}`;
		urls[name] = await bundle({
			src: path.join(REPO_ROOT, "extensions", packageDir, "index.ts"),
			outDir,
			outName: `${name}.mjs`,
			aliases,
			npx: "--yes",
		});
	}
	return { outDir, urls };
}

// A module keeps a singleton (activeLoops / activePlans). Load a FRESH instance per
// scenario via a cache-busting query so scenarios never leak state into each other.

// ---------------------------------------------------------------------------
// Mock pi + ctx (shape mirrors the ExtensionAPI / ExtensionContext surface the
// extensions actually use, learned from the real handlers).
// ---------------------------------------------------------------------------
function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content, options) => sentMessages.push({ content, options }),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, handlers, entries, sentMessages };
}

function makeCtx({ mode = "tui", hasUI = true, confirmResult = true, cwd = TEST_PROJECT_ROOT, entries = [] } = {}) {
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: () => {},
			setStatus: () => {},
			confirm: async () => ctx._confirmResult,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => entries },
	};
	ctx._confirmResult = confirmResult;
	return ctx;
}

function toolCallEvent(toolName, input = {}) {
	return {
		type: "tool_call",
		toolCallId: `tc-${Math.random().toString(16).slice(2)}`,
		toolName,
		input,
	};
}

// Run every registered tool_call handler; first blocker wins (mirrors the engine).
async function runGate(handlers, ctx, event) {
	for (const h of handlers.get("tool_call") || []) {
		const res = await h(event, ctx);
		if (res?.block) return res;
	}
	return undefined;
}

// ===========================================================================
// SCENARIO 3: loop.ts autopilot destructive gate. Only armed while a loop is in
// autopilot (i.e. the turn was triggered by a wake, not a human). Starting a loop
// in tui mode fires the first wake synchronously, setting autopilot=true.
// ===========================================================================
async function loopAutopilotGate(loopUrl) {
	const loopExtension = await loadDefault(loopUrl);
	const { pi, commands, handlers } = makePi();
	loopExtension(pi);
	const cwd = TEST_PROJECT_ROOT;
	const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: false, cwd });

	// Before any loop: gate is inert (no autopilot active) -> destructive command allowed.
	const preRm = await runGate(handlers, ctx, toolCallEvent("bash", { command: "rm -rf /tmp/x" }));
	check("loop: rm -rf ALLOWED before any loop (no autopilot)", preRm === undefined);

	// Start a loop. fireWake() runs synchronously and sets autopilot=true on this loop.
	commands.get("loop").handler("keep the build green", ctx);

	// While autopilot is active (confirmResult=false => deny), destructive bash is BLOCKED.
	for (const cmd of [
		"rm -rf build",
		"rm -fr build",
		"git push --force origin main",
		"git push -f",
		"git reset --hard HEAD~1",
		"git clean -fd",
		"dd if=/dev/zero of=/dev/sda",
		"mkfs.ext4 /dev/sdb",
		"terraform apply -auto-approve",
		"kubectl delete pod x",
		// Recursive rm without -f, and find/truncate/shred deletions.
		"rm -r build",
		"find . -name '*.sqlite' -delete",
		"find . -type f -exec rm {} +",
		"truncate -s 0 important.db",
		"shred -u secret.key",
		// Shell redirections / tee writing OUTSIDE the project (parity with write/edit).
		"echo x > /etc/cron.d/pwn",
		"echo x | tee /etc/hosts",
		// L1: tilde (~) and unexpanded shell vars ($HOME/${HOME}) resolve OUTSIDE the
		// project at shell-expansion time; our path math never expands them, so they
		// must be treated as out-of-project writes.
		"echo pwn >> ~/.bashrc",
		"echo pwn > $HOME/.profile",
		"echo pwn > ${HOME}/.evil",
		"echo pwn | tee ~/.ssh/authorized_keys",
		// L2: a `cd`/`pushd` to a dir we cannot prove is in-project makes a RELATIVE
		// redirect target unsafe (it no longer resolves under ctx.cwd).
		"cd /etc && echo x > hosts",
		"cd /tmp && echo x | tee secret.key",
		"cd ~ && echo x > .bashrc",
		"cd && echo x > .bashrc",
		"cd .. && echo x > escaped.txt",
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`loop(autopilot): BLOCKS bash "${cmd}"`, !!r && r.block === true, r ? "" : "not blocked");
	}

	// Non-destructive bash is allowed even under autopilot. In-project redirects and
	// fd-dups (2>&1) must NOT be mistaken for out-of-project writes.
	for (const cmd of [
		"npm test",
		"git status",
		"ls -la",
		"rm foo.txt",
		"git commit -m x",
		"echo hi > notes.txt",
		"node build.js > out.log 2>&1",
		"cmd 2>&1",
		"echo ok > /dev/null",
		// L2 false-positive guards: an IN-PROJECT cd, a substring "cd" inside a path,
		// and /dev/null after an out-of-project cd must all stay ALLOWED.
		"cd build && echo x > out.log",
		"cat src/cd/file > out.txt",
		"cd /etc && echo ok > /dev/null",
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`loop(autopilot): ALLOWS bash "${cmd}"`, r === undefined, r ? r.reason : "");
	}

	// write/edit: blocked only when the path escapes the project root.
	const outside = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "/etc/passwd", content: "x" }));
	check("loop(autopilot): BLOCKS write to /etc/passwd (outside project)", !!outside && outside.block === true);
	const traversal = await runGate(handlers, ctx, toolCallEvent("edit", { file_path: "../../secret" }));
	check("loop(autopilot): BLOCKS edit via .. traversal", !!traversal && traversal.block === true);
	const inside = await runGate(
		handlers,
		ctx,
		toolCallEvent("write", { file_path: path.join(cwd, "fixtures/x.txt"), content: "x" }),
	);
	check("loop(autopilot): ALLOWS write inside project", inside === undefined, inside ? inside.reason : "");
	const relInside = await runGate(
		handlers,
		ctx,
		toolCallEvent("write", { file_path: "fixtures/x.txt", content: "x" }),
	);
	check(
		"loop(autopilot): ALLOWS relative write inside project",
		relInside === undefined,
		relInside ? relInside.reason : "",
	);
}

// ===========================================================================
// SCENARIO 4: loop_schedule delay CLAMP to [60, 3600] (the single defense — the
// model is never trusted). Drive the registered tool's execute() directly.
// ===========================================================================
async function loopScheduleClamp(loopUrl) {
	const loopExtension = await loadDefault(loopUrl);
	const { pi, commands, tools } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	// Need a running DYNAMIC loop for loop_schedule to act on.
	commands.get("loop").handler("a dynamic task", ctx);
	const sched = tools.get("loop_schedule");
	check("loop_schedule tool registered", !!sched);

	async function delayFor(raw) {
		const res = await sched.execute("tc", { delaySeconds: raw, reason: "test clamp" }, undefined, undefined, ctx);
		return res.details ? res.details.delaySeconds : undefined;
	}

	check("loop_schedule: 5 clamps up to 60", (await delayFor(5)) === 60);
	check("loop_schedule: 30 clamps up to 60", (await delayFor(30)) === 60);
	check("loop_schedule: 1800 passes through", (await delayFor(1800)) === 1800);
	check("loop_schedule: 99999 clamps down to 3600", (await delayFor(99999)) === 3600);
	check("loop_schedule: 60 (lower bound) stays 60", (await delayFor(60)) === 60);
	check("loop_schedule: 3600 (upper bound) stays 3600", (await delayFor(3600)) === 3600);
	check("loop_schedule: NaN falls back to safety net (1500)", (await delayFor(Number.NaN)) === 1500);
}

// ===========================================================================
async function main() {
	const { outDir, urls } = await buildExtensions(["loop"]);
	TEST_PROJECT_ROOT = path.join(outDir, "project");
	await fs.mkdir(TEST_PROJECT_ROOT, { recursive: true });
	try {
		await loopAutopilotGate(urls.loop);
		await loopScheduleClamp(urls.loop);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	// Started loops leave live setTimeout timers in loop tests; exit explicitly so
	// the behavior runner never hangs after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
