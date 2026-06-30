#!/usr/bin/env node
/**
 * Durable contract guard for the session-switch command argument quoting/parsing.
 *
 * The dashboard hands a Pi-session file off to the prompt as a slash command
 * (dashboard-orchestration.ts, switchToPiSession):
 *
 *     options.submitCommand(`/workflow switch-session ${quoteWorkflowCommandArgument(sessionFile)}`)
 *
 * where `quoteWorkflowCommandArgument(value) === JSON.stringify(value)`. The command
 * handler then tokenizes the args with `/^(\S+)(?:\s+([\s\S]*))?$/` to split the action
 * from its argument and recovers the path with the EXPORTED helper
 * `parseWorkflowCommandArgument` (command-handlers.ts, action === "switch-session").
 *
 * The non-obvious invariant that makes session switching work for real-world paths —
 * those with spaces, unicode, embedded quotes, or backslashes — is:
 *
 *     parseWorkflowCommandArgument(JSON.stringify(path)) === path
 *
 * and the handler's whitespace-tokenizing split must not corrupt that quoted argument.
 * There was NO coverage on this path. A tempting "simplification" of the quoting to a
 * bare string (or of the parser to a naive quote-strip / space-split) would silently
 * break any session file with a space in it. This pins the observable round-trip.
 *
 * Pure: bundles dashboard-orchestration.ts with the shared client stubs and calls the
 * exported parser in memory. Reproduces the producer (JSON.stringify) and the handler's
 * tokenizer split locally, with pointers to the source of truth above.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/switch-session-arg-roundtrip.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, loadModule, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// Mirror of command-handlers.ts: action/arg split applied to the trimmed args.
const ACTION_SPLIT = /^(\S+)(?:\s+([\s\S]*))?$/;

/** What the handler sees as `afterAction` for the submitted /workflow command. */
function handlerAfterAction(submittedArgs) {
	const m = ACTION_SPLIT.exec(submittedArgs.trim());
	return m?.[2]?.trimStart() ?? "";
}

async function loadRuntime() {
	const { url } = await buildExtension({
		name: "pi-dw-switch-session-arg",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "dashboard-orchestration.ts"),
		outName: "dashboard-orchestration.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
		npx: "--yes",
	});
	return await loadModule(url);
}

async function main() {
	const { parseWorkflowCommandArgument } = await loadRuntime();
	check(
		"exports parseWorkflowCommandArgument",
		typeof parseWorkflowCommandArgument === "function",
		typeof parseWorkflowCommandArgument,
	);

	// Real-world Pi-session file paths that MUST survive the producer→handler→parser trip.
	const paths = [
		"/Users/me/.pi/sessions/a.json",
		"/Users/me/My Sessions/with spaces.json",
		"/tmp/únïcode/sesión.json",
		'/a/"weird"/b.json',
		"C:\\Users\\me\\AppData\\s.json",
		"/path/with\ttab.json",
		"   /leading-and-trailing.json   ",
		"relative/path.json",
	];

	// 1) Core invariant on the exported helper: it inverts the producer's JSON.stringify.
	for (const p of paths) {
		const quoted = JSON.stringify(p); // === quoteWorkflowCommandArgument(p)
		check(
			`parse(JSON.stringify(path)) round-trips: ${JSON.stringify(p)}`,
			parseWorkflowCommandArgument(quoted) === p,
			`quoted=${quoted} got=${JSON.stringify(parseWorkflowCommandArgument(quoted))}`,
		);
	}

	// 2) Full path as the handler actually runs it: build the submitted command, apply the
	//    handler's tokenizer split, then parse — the quoted arg must not be corrupted by the
	//    whitespace split even when the path itself contains spaces/tabs.
	for (const p of paths) {
		const submitted = `switch-session ${JSON.stringify(p)}`;
		const recovered = parseWorkflowCommandArgument(handlerAfterAction(submitted));
		check(
			`handler split + parse round-trips: ${JSON.stringify(p)}`,
			recovered === p,
			`submitted=${JSON.stringify(submitted)} got=${JSON.stringify(recovered)}`,
		);
	}

	// 3) Empty / blank argument → undefined (handler shows the "Usage:" warning, never switches).
	check("empty arg → undefined", parseWorkflowCommandArgument("") === undefined);
	check("blank arg → undefined", parseWorkflowCommandArgument("   ") === undefined);

	// 4) A bare (unquoted) absolute path passes through verbatim — the handler accepts a path
	//    typed without JSON quoting, and `[\s\S]*` keeps multi-word bare paths intact too.
	check(
		"bare unquoted path passes through",
		parseWorkflowCommandArgument("/no/quotes.json") === "/no/quotes.json",
		JSON.stringify(parseWorkflowCommandArgument("/no/quotes.json")),
	);
	check(
		"bare unquoted multi-word path passes through",
		parseWorkflowCommandArgument("/My Sessions/a.json") === "/My Sessions/a.json",
		JSON.stringify(parseWorkflowCommandArgument("/My Sessions/a.json")),
	);

	// 5) A malformed leading-quote argument → undefined (rejected, not half-parsed).
	check(
		"malformed leading-quote arg → undefined",
		parseWorkflowCommandArgument('"unterminated') === undefined,
		JSON.stringify(parseWorkflowCommandArgument('"unterminated')),
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
