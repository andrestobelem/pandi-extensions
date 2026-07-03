#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-exit/index.ts.
 *
 * Pins the public /exit contract (a Claude-style alias for pi's native /quit):
 * - registers a slash command named "exit" with a non-empty description
 * - the handler triggers a clean shutdown via ctx.shutdown() exactly once
 * - the handler ignores any arguments and still shuts down
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makePi() {
	const commands = new Map();
	const pi = { registerCommand: (name, opts) => commands.set(name, opts) };
	return { pi, commands };
}

function makeCtx() {
	const calls = { shutdown: 0 };
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify: () => {} },
		shutdown: () => {
			calls.shutdown += 1;
		},
	};
	ctx._calls = calls;
	return ctx;
}

async function main() {
	const ext = await buildExtension({
		name: "pi-exit-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-exit", "index.ts"),
		outName: "exit.mjs",
	});
	try {
		const exitExtension = await loadDefault(ext.url);

		const h = makePi();
		exitExtension(h.pi);
		const cmd = h.commands.get("exit");
		check("/exit command registered", !!cmd);
		check("/exit has a description", typeof cmd?.description === "string" && cmd.description.length > 0);

		const ctx = makeCtx();
		await cmd.handler("", ctx);
		check("/exit calls ctx.shutdown() once", ctx._calls.shutdown === 1, String(ctx._calls.shutdown));

		const ctx2 = makeCtx();
		await cmd.handler("  some ignored args  ", ctx2);
		check("/exit ignores args and still shuts down once", ctx2._calls.shutdown === 1, String(ctx2._calls.shutdown));
	} finally {
		await fs.rm(ext.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
