import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { FileOperations } from "@earendil-works/pi-coding-agent";

export const DEFAULT_FAST_SUMMARY_MODEL = "anthropic/claude-sonnet-5";
export const CODEX_FAST_SUMMARY_MODEL = "openai-codex/gpt-5.5";
export const FAST_SUMMARY_MODEL_FALLBACKS = [
	DEFAULT_FAST_SUMMARY_MODEL,
	CODEX_FAST_SUMMARY_MODEL,
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-3-haiku-20240307",
] as const;
export const DEFAULT_SUMMARY_MAX_TOKENS = 4096;
export const DEFAULT_SUMMARY_MAX_INPUT_CHARS = 80_000;
export const FAST_SUMMARY_REASONING = "minimal";

export interface FastSummaryPromptInput {
	previousSummary?: string;
	conversationText: string;
	turnPrefixText?: string;
	customInstructions?: string;
	fileOps?: FileOperations;
	isSplitTurn?: boolean;
	maxInputChars: number;
}

export interface FastSummaryPromptResult {
	prompt: string;
	readFiles: string[];
	modifiedFiles: string[];
	inputChars: number;
	truncated: boolean;
}

const uniqueSorted = (values: Iterable<string>): string[] =>
	[...new Set([...values].filter((v): v is string => typeof v === "string" && v.length > 0))].sort();

const toArray = (value: unknown): string[] => {
	if (value instanceof Set) return uniqueSorted(value as Set<string>);
	if (Array.isArray(value)) return uniqueSorted(value.filter((v): v is string => typeof v === "string"));
	return [];
};

export function fileOpsToLists(fileOps: FileOperations | undefined): { readFiles: string[]; modifiedFiles: string[] } {
	const read = toArray(fileOps?.read);
	const modifiedFiles = uniqueSorted([...toArray(fileOps?.written), ...toArray(fileOps?.edited)]);
	const modified = new Set(modifiedFiles);
	return {
		readFiles: read.filter((file) => !modified.has(file)),
		modifiedFiles,
	};
}

export function compactText(value: string | undefined, maxChars: number): { text: string; truncated: boolean } {
	const text = value ?? "";
	if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
	const headChars = Math.max(0, Math.floor(maxChars * 0.65));
	const tailChars = Math.max(0, maxChars - headChars);
	const removed = Math.max(0, text.length - headChars - tailChars);
	return {
		text: `${text.slice(0, headChars)}\n…[truncated ${removed} chars for fast compaction]…\n${text.slice(text.length - tailChars)}`,
		truncated: true,
	};
}

const asBlock = (title: string, body: string): string => `\n## ${title}\n${body.trim() || "(none)"}\n`;

export function buildFastSummaryPrompt(input: FastSummaryPromptInput): FastSummaryPromptResult {
	const maxInputChars = Math.max(4_000, input.maxInputChars);
	const previousBudget = Math.min(12_000, Math.floor(maxInputChars * 0.15));
	const customBudget = Math.min(2_000, Math.floor(maxInputChars * 0.05));
	const turnBudget = input.turnPrefixText ? Math.min(20_000, Math.floor(maxInputChars * 0.25)) : 0;
	const conversationBudget = Math.max(4_000, maxInputChars - previousBudget - customBudget - turnBudget);

	const previous = compactText(input.previousSummary, previousBudget);
	const custom = compactText(input.customInstructions, customBudget);
	const conversation = compactText(input.conversationText, conversationBudget);
	const turnPrefix = compactText(input.turnPrefixText, turnBudget);
	const { readFiles, modifiedFiles } = fileOpsToLists(input.fileOps);
	const fileTags = `${asBlock("Read files", readFiles.join("\n"))}${asBlock("Modified files", modifiedFiles.join("\n"))}`;

	const prompt = `Sos el compactor rápido de una sesión larga de Pi. Convertí el material de abajo en un resumen OPERATIVO para poder continuar el trabajo con menos contexto.

Reglas:
- Devolvé SOLO Markdown.
- No transcribas la conversación ni outputs largos.
- Conservá objetivo actual, restricciones/preferencias, decisiones, estado, bloqueos, próximos pasos y archivos importantes.
- Si algo no está confirmado, marcá la incertidumbre explícitamente.
- Incluí al final los tags <read-files> y <modified-files> con los paths provistos; no inventes paths.
- Preferí bullets cortos, accionables y verificables.

Formato requerido:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
<read-files>
...
</read-files>
<modified-files>
...
</modified-files>

${asBlock("Previous compaction summary", previous.text)}${asBlock("Custom instructions", custom.text)}${fileTags}${asBlock("Conversation to summarize", conversation.text)}${
	input.isSplitTurn ? asBlock("Early part of the split current turn", turnPrefix.text) : ""
}

Recordatorio final: resumí solo lo necesario para CONTINUAR el trabajo; no incluyas transcript ni ruido.`;

	return {
		prompt,
		readFiles,
		modifiedFiles,
		inputChars: prompt.length,
		truncated: previous.truncated || custom.truncated || conversation.truncated || turnPrefix.truncated,
	};
}

export function extractFastSummaryText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
