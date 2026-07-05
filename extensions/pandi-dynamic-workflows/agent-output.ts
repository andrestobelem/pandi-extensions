/**
 * Parsing de agent-output de pandi-dynamic-workflows (puro).
 *
 * Convierte un event stream en modo JSON de Pi (el stdout de un run `pi` no interactivo)
 * en el texto final del assistant: extrae texto del contenido de mensajes, toma el
 * texto del assistant desde un mensaje y reduce el event stream al último
 * texto de assistant (variantes strict + lenient). Completamente autocontenido — sin ctx,
 * sin imports node/SDK, sin estado compartido — así que es trivial de testear.
 *
 * Extraído textualmente desde index.ts (preserva comportamiento). Sibling de profundidad uno
 * importado vía "./agent-output.js"; los tres helpers extract* / *Internal quedan
 * privados del módulo, solo se exportan los dos entry points de parse.
 */

function extractTextFromMessageContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = content.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const record = part as Record<string, unknown>;
				if ((record.type === "text" || record.type === undefined) && typeof record.text === "string")
					return record.text;
			}
			return "";
		});
		return parts.join("");
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if ((record.type === "text" || record.type === undefined) && typeof record.text === "string") return record.text;
	}
	return undefined;
}

function extractAssistantTextFromMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	return extractTextFromMessageContent(record.content);
}

export function parsePiJsonModeOutput(stdout: string): { ok: true; output: string } | { ok: false; warning: string } {
	return parsePiJsonModeOutputInternal(stdout, false);
}

export function parsePiJsonModeOutputLenient(
	stdout: string,
): { ok: true; output: string } | { ok: false; warning: string } {
	return parsePiJsonModeOutputInternal(stdout, true);
}

function parsePiJsonModeOutputInternal(
	stdout: string,
	lenient: boolean,
): { ok: true; output: string } | { ok: false; warning: string } {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length === 0) return { ok: false, warning: "empty JSON event stream" };
	let lastAssistantText: string | undefined;
	let skippedInvalid = 0;
	for (let i = 0; i < lines.length; i++) {
		let event: unknown;
		try {
			event = JSON.parse(lines[i]);
		} catch (err) {
			if (lenient) {
				skippedInvalid++;
				continue;
			}
			return {
				ok: false,
				warning: `invalid JSON event line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (!event || typeof event !== "object") continue;
		const record = event as Record<string, unknown>;
		// Solo texto NO VACÍO puede convertirse en la salida final: un mensaje de assistant solo con tool-calls
		// o solo con thinking extrae "" (sus partes mapean a "" y se unen), y dejar que eso sobrescriba
		// texto real anterior pierde silenciosamente toda la respuesta (ok:true, output:"") — visto con reviewers
		// largos y cargados de tools cuyo mensaje final fue una tool call (2026-07-03 revisar-dw-farley-core).
		if (record.type === "agent_end" && Array.isArray(record.messages)) {
			for (const message of record.messages) {
				const textValue = extractAssistantTextFromMessage(message);
				if (textValue !== undefined && textValue.trim() !== "") lastAssistantText = textValue;
			}
			continue;
		}
		if (record.type === "turn_end" || record.type === "message_end" || record.type === "message_update") {
			const textValue = extractAssistantTextFromMessage(record.message);
			if (textValue !== undefined && textValue.trim() !== "") lastAssistantText = textValue;
		}
	}
	if (lastAssistantText === undefined) {
		return {
			ok: false,
			warning: skippedInvalid
				? `no assistant text found in complete JSON events (${skippedInvalid} partial/invalid line(s) ignored)`
				: "no assistant text found in JSON event stream",
		};
	}
	return { ok: true, output: lastAssistantText.trim() };
}
