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
		text: `${text.slice(0, headChars)}\n…[recortados ${removed} caracteres para la compactación rápida]…\n${text.slice(text.length - tailChars)}`,
		truncated: true,
	};
}

const asBlock = (title: string, body: string): string => `\n## ${title}\n${body.trim() || "(ninguno)"}\n`;

const deriveFastSummaryBudgets = (
	maxInputChars: number,
	turnPrefixText: string | undefined,
): { previousBudget: number; customBudget: number; turnBudget: number; conversationBudget: number } => {
	const normalizedMaxInputChars = Math.max(4_000, maxInputChars);
	const previousBudget = Math.min(12_000, Math.floor(normalizedMaxInputChars * 0.15));
	const customBudget = Math.min(2_000, Math.floor(normalizedMaxInputChars * 0.05));
	const turnBudget = turnPrefixText ? Math.min(20_000, Math.floor(normalizedMaxInputChars * 0.25)) : 0;
	const conversationBudget = Math.max(4_000, normalizedMaxInputChars - previousBudget - customBudget - turnBudget);

	return { previousBudget, customBudget, turnBudget, conversationBudget };
};

export function buildFastSummaryPrompt(input: FastSummaryPromptInput): FastSummaryPromptResult {
	const { previousBudget, customBudget, turnBudget, conversationBudget } = deriveFastSummaryBudgets(
		input.maxInputChars,
		input.turnPrefixText,
	);

	const previous = compactText(input.previousSummary, previousBudget);
	const custom = compactText(input.customInstructions, customBudget);
	const conversation = compactText(input.conversationText, conversationBudget);
	const turnPrefix = compactText(input.turnPrefixText, turnBudget);
	const { readFiles, modifiedFiles } = fileOpsToLists(input.fileOps);
	const fileTags = `${asBlock("Archivos leídos", readFiles.join("\n"))}${asBlock("Archivos modificados", modifiedFiles.join("\n"))}`;

	const prompt = `Sos el compactor rápido de una sesión larga de Pi. Convertí el material de abajo en un resumen OPERATIVO para continuar el trabajo con menos contexto.

Reglas:
- Devolvé SOLO Markdown.
- No transcribas la conversación ni outputs largos.
- Conservá el objetivo actual, las restricciones/preferencias, las decisiones, el estado, los bloqueos, los próximos pasos y los archivos importantes.
- Si algo no está confirmado, marcá la incertidumbre explícitamente.
- Incluí al final los tags <read-files> y <modified-files> con los paths provistos; no inventes paths.
- Preferí bullets cortos, accionables y verificables.

Formato requerido:
## Objetivo
## Restricciones y preferencias
## Progreso
### Hecho
### En curso
### Bloqueado
## Decisiones clave
## Próximos pasos
## Contexto crítico
<read-files>
...
</read-files>
<modified-files>
...
</modified-files>

${asBlock("Resumen de compactación anterior", previous.text)}${asBlock("Instrucciones personalizadas", custom.text)}${fileTags}${asBlock("Conversación a resumir", conversation.text)}${
	input.isSplitTurn ? asBlock("Primera parte del turno actual dividido", turnPrefix.text) : ""
}

Recordatorio final: resumí solo lo necesario para CONTINUAR el trabajo; no incluyas transcripción ni ruido.`;

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
