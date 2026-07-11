#!/usr/bin/env node
/**
 * Regresión: un subagente cuyo mensaje assistant FINAL es solo tool-call no debe
 * perder su output real.
 *
 * Bug encontrado por la review Farley de 2026-07-03 (run revisar-dw-farley-core):
 * dos reviewers corrieron ~8 min, salieron ok:true code:0 con un event stream de 4.4MB que
 * CONTENÍA el markdown completo de review — pero el output extraído fue "". Causa:
 * extractTextFromMessageContent mapea partes no-texto (toolCall/thinking) a "" y
 * las join("")ea, así un mensaje assistant solo-tool produce "" (no undefined), y
 * el fold `if (textValue !== undefined) lastAssistantText = textValue` deja que ese
 * string vacío SOBRESCRIBA el texto real anterior. Pérdida silenciosa de datos reportada como
 * success.
 *
 * Contrato pineado acá (agent-output.ts):
 *   - El output final es el último texto assistant NO VACÍO: un mensaje assistant trailing solo-tool
 *     (o sin texto por otro motivo) nunca pisa texto real previo,
 *     tanto en los eventos incrementales (message_end/turn_end/message_update) como en el replay
 *     agent_end.messages.
 *   - Dos textos reales → el posterior sigue ganando (comportamiento existente preservado).
 *   - Un stream SIN texto assistant en absoluto sigue devolviendo ok:false.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

const textMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolOnlyMsg = () => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }],
});
const line = (obj) => JSON.stringify(obj);
const stream = (...events) => `${events.map(line).join("\n")}\n`;
const assistantEvent = (type, message) => ({ type, message });

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-agent-output-tool-final",
		relPath: "runtime/agent-output.ts",
		outName: "agent-output.mjs",
	});
	const { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } = await loadModule(url);
	check("parsePiJsonModeOutput exported", typeof parsePiJsonModeOutput === "function");

	// --- el bug: el mensaje trailing solo-tool no debe pisar texto real ---------
	for (const eventType of ["message_end", "turn_end", "message_update"]) {
		const toolFinal = parsePiJsonModeOutput(
			stream(
				assistantEvent(eventType, textMsg("## Findings\nthe real review")),
				assistantEvent(eventType, toolOnlyMsg()),
			),
		);
		check(`trailing tool-only ${eventType} keeps real text`, toolFinal.ok === true, JSON.stringify(toolFinal));
		check(
			`trailing tool-only ${eventType}: output is the review`,
			toolFinal.ok && toolFinal.output === "## Findings\nthe real review",
			JSON.stringify(toolFinal),
		);
	}

	// Variante de replay agent_end (el path de replay de mensajes completos).
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

	// Texto solo-whitespace se comporta como sin texto (tampoco debe pisar).
	const wsFinal = parsePiJsonModeOutput(
		stream({ type: "message_end", message: textMsg("real") }, { type: "message_end", message: textMsg("   \n  ") }),
	);
	check("whitespace-only final does not clobber", wsFinal.ok && wsFinal.output === "real", JSON.stringify(wsFinal));

	// --- comportamiento existente preservado -------------------------------------
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
