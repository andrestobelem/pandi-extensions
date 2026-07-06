/**
 * Tests de integración chicos para el parser puro de intención de `/loop`.
 *
 * El engine completo ya está cubierto por loop-behavior/loop-caps-resume/safety/ultracode;
 * esta suite fija la gramática antes de extraerla de index.ts para que el refactor sea
 * TDD y reversible.
 *
 * Ejecutarlo:
 *   node extensions/pandi-loop/tests/integration/loop-command-intent.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadModule, makeBuildDir } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildCommandIntent() {
	const { outDir, aliases } = await makeBuildDir("pi-loop-command-intent");
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "command-intent.ts"),
		outDir,
		outName: "command-intent.mjs",
		aliases,
	});
	return { outDir, url };
}

function same(label, actual, expected) {
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)}`);
}

async function parserContract(url) {
	const mod = await loadModule(url);
	const { extractUltracodeFlag, parseLoopCommandIntent, parseLoopStartArgs } = mod;

	same(
		"flag: strips --ultracode and collapses task whitespace",
		extractUltracodeFlag(" --ultracode  watch   build "),
		{
			rest: "watch build",
			ultracode: true,
		},
	);
	same("flag: strips --uc case-insensitively wherever it appears", extractUltracodeFlag("watch --UC build 5m"), {
		rest: "watch build 5m",
		ultracode: true,
	});
	same("flag: leaves normal text untouched apart from token normalization", extractUltracodeFlag("watch build"), {
		rest: "watch build",
		ultracode: false,
	});

	same("start: dynamic task", parseLoopStartArgs("watch build"), {
		text: "watch build",
		intervalMs: undefined,
		ultracode: false,
	});
	same("start: fixed interval strips the trailing token", parseLoopStartArgs("watch build 5m"), {
		text: "watch build",
		intervalMs: 300000,
		ultracode: false,
	});
	same("start: ultracode flag does not eat fixed interval", parseLoopStartArgs("--uc watch build 5m"), {
		text: "watch build",
		intervalMs: 300000,
		ultracode: true,
	});
	same("start: a lone interval token remains a dynamic task", parseLoopStartArgs("5m"), {
		text: "5m",
		intervalMs: undefined,
		ultracode: false,
	});
	same("start: invalid interval token remains part of task", parseLoopStartArgs("watch build 10x"), {
		text: "watch build 10x",
		intervalMs: undefined,
		ultracode: false,
	});
	same("start: empty after flags stays empty", parseLoopStartArgs("--ultracode"), {
		text: "",
		intervalMs: undefined,
		ultracode: true,
	});

	same("intent: stop with id", parseLoopCommandIntent("stop abc123"), {
		kind: "stop",
		rest: "abc123",
	});
	same("intent: pause with no id", parseLoopCommandIntent("pause"), {
		kind: "pause",
		rest: "",
	});
	same("intent: resume trims id whitespace", parseLoopCommandIntent("resume   abc123 "), {
		kind: "resume",
		rest: "abc123",
	});
	same("intent: status lowercases only the command token", parseLoopCommandIntent("STATUS LoopA"), {
		kind: "status",
		rest: "LoopA",
	});
	same("intent: auto carries the rest for autonomous parsing", parseLoopCommandIntent("auto --uc watch build 5m"), {
		kind: "auto",
		rest: "--uc watch build 5m",
	});
	same("intent: default is start with trimmed args", parseLoopCommandIntent("  watch build  "), {
		kind: "start",
		rest: "watch build",
	});
	same("intent: empty args are still routed to start for the usage message", parseLoopCommandIntent("   "), {
		kind: "start",
		rest: "",
	});
}

async function main() {
	const { url } = await buildCommandIntent();
	await parserContract(url);

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
