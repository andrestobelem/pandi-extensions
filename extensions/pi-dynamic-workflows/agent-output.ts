/**
 * pi-dynamic-workflows agent-output parsing (pure).
 *
 * Turns a Pi JSON-mode event stream (the stdout of a non-interactive `pi` run)
 * into the final assistant text: extract text from message content, pull the
 * assistant text out of a message, and fold the event stream down to the last
 * assistant text (strict + lenient variants). Fully self-contained — no ctx, no
 * node/SDK imports, no shared state — so it is trivially testable.
 *
 * Extracted verbatim from index.ts (behavior-preserving). Depth-one sibling
 * imported via "./agent-output.js"; the three extract* / *Internal helpers stay
 * module-private, only the two parse entry points are exported.
 */

function extractTextFromMessageContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = content.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const record = part as Record<string, unknown>;
				if (
					(record.type === "text" || record.type === undefined) &&
					typeof record.text === "string"
				)
					return record.text;
			}
			return "";
		});
		return parts.join("");
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if ((record.type === "text" || record.type === undefined) && typeof record.text === "string")
			return record.text;
	}
	return undefined;
}

function extractAssistantTextFromMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	return extractTextFromMessageContent(record.content);
}

export function parsePiJsonModeOutput(
	stdout: string,
): { ok: true; output: string } | { ok: false; warning: string } {
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
		if (record.type === "agent_end" && Array.isArray(record.messages)) {
			for (const message of record.messages) {
				const textValue = extractAssistantTextFromMessage(message);
				if (textValue !== undefined) lastAssistantText = textValue;
			}
			continue;
		}
		if (
			record.type === "turn_end" ||
			record.type === "message_end" ||
			record.type === "message_update"
		) {
			const textValue = extractAssistantTextFromMessage(record.message);
			if (textValue !== undefined) lastAssistantText = textValue;
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
