#!/usr/bin/env node
/**
 * Regression: a subagent whose FINAL assistant message is tool-call-only must not
 * lose its real output.
 *
 * Bug found by the Farley review of 2026-07-03 (run revisar-dw-farley-core):
 * two reviewers ran ~8 min, exited ok:true code:0 with a 4.4MB event stream that
 * CONTAINED the full review markdown — but the extracted output was "". Cause:
 * extractTextFromMessageContent maps non-text parts (toolCall/thinking) to "" and
 * join("")s them, so a tool-only assistant message yields "" (not undefined), and
 * the fold `if (textValue !== undefined) lastAssistantText = textValue` lets that
 * empty string OVERWRITE the earlier real text. Silent data loss reported as
 * success.
 *
 * Contract pinned here (agent-output.ts):
 *   - The final output is the last NON-EMPTY assistant text: a trailing tool-only
 *     (or otherwise textless) assistant message never clobbers earlier real text,
 *     in both the incremental events (message_end/turn_end/message_update) and the
 *     agent_end.messages replay.
 *   - Two real texts → the later one still wins (existing behavior preserved).
 *   - A stream with NO assistant text at all still returns ok:false.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const textMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolOnlyMsg = () => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }],
});
const line = (obj) => JSON.stringify(obj);
const stream = (...events) => `${events.map(line).join("\n")}\n`;

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-agent-output-tool-final",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "agent-output.ts"),
		outName: "agent-output.mjs",
		stubs: { tui: true },
	});
	const { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } = await loadModule(url);
	check("parsePiJsonModeOutput exported", typeof parsePiJsonModeOutput === "function");

	// --- the bug: trailing tool-only message must not clobber real text ---------
	const toolFinal = parsePiJsonModeOutput(
		stream(
			{ type: "message_end", message: textMsg("## Findings\nthe real review") },
			{ type: "message_end", message: toolOnlyMsg() },
		),
	);
	check("trailing tool-only message_end keeps real text", toolFinal.ok === true, JSON.stringify(toolFinal));
	check(
		"trailing tool-only: output is the review",
		toolFinal.ok && toolFinal.output === "## Findings\nthe real review",
		JSON.stringify(toolFinal),
	);

	// agent_end replay variant (the full-messages replay path).
	const replay = parsePiJsonModeOutput(
		stream({
			type: "agent_end",
			messages: [textMsg("the real review"), toolOnlyMsg()],
		}),
	);
	check(
		"agent_end replay: tool-only final keeps real text",
		replay.ok && replay.output === "the real review",
		JSON.stringify(replay),
	);

	// Whitespace-only text behaves like no text (must not clobber either).
	const wsFinal = parsePiJsonModeOutput(
		stream({ type: "message_end", message: textMsg("real") }, { type: "message_end", message: textMsg("   \n  ") }),
	);
	check("whitespace-only final does not clobber", wsFinal.ok && wsFinal.output === "real", JSON.stringify(wsFinal));

	// --- existing behavior preserved ---------------------------------------------
	const lastWins = parsePiJsonModeOutput(
		stream({ type: "message_end", message: textMsg("first") }, { type: "message_end", message: textMsg("second") }),
	);
	check("later real text still wins", lastWins.ok && lastWins.output === "second", JSON.stringify(lastWins));

	const noText = parsePiJsonModeOutput(stream({ type: "message_end", message: toolOnlyMsg() }));
	check("no assistant text at all → ok:false", noText.ok === false, JSON.stringify(noText));

	const lenient = parsePiJsonModeOutputLenient(
		`not-json\n${stream(
			{ type: "message_end", message: textMsg("kept") },
			{ type: "message_end", message: toolOnlyMsg() },
		)}`,
	);
	check("lenient variant: same guard", lenient.ok && lenient.output === "kept", JSON.stringify(lenient));

	report();
}

function report() {
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
