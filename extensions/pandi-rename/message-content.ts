function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return (
		!!block && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string"
	);
}

/** Extrae y une bloques de texto desde el formato de contenido de mensaje del SDK. */
export function textContentFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((block) => block.text)
		.join(" ");
}
