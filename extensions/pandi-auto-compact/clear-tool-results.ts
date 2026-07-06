// Centinela embebido en el texto elidido de tool-result. Detectarlo vuelve idempotente a la limpieza
// (un reintento nunca vuelve a limpiar texto ya limpiado) y les deja a los humanos ver salida recortada.
export const CLEARED_SENTINEL = "[pi-auto-compact cleared";

export interface ClearToolResultsOptions {
	/** Mantiene los N tool results más recientes completamente intactos (zona de recencia). */
	keepRecent: number;
	/** Solo elide bloques de texto más largos que esto. */
	minChars: number;
	/** Caracteres del inicio original que se conservan. */
	headChars: number;
	/** Caracteres del final original que se conservan (la "decision tail"). */
	tailChars: number;
}

// Limpieza pura y no mutante de tool-result (research §3b). Devuelve un array NUEVO con el
// TEXTO voluminoso de tool results consumidos y VIEJOS elidido a inicio + marcador + final, o null cuando
// nada cambió. Conserva la identidad del mensaje para todo lo que no toca; mantiene
// toolCallId/toolName/isError y bloques de imagen; CONSERVA los últimos keepRecent resultados y los
// resultados con error (señal de recuperación), y es idempotente vía CLEARED_SENTINEL. Quien llama
// la aplica solo por llamada al LLM — la sesión conserva los originales, así que es efímera
// y totalmente recuperable, nunca destructiva.
export const clearOldToolResults = (messages: readonly unknown[], opts: ClearToolResultsOptions): unknown[] | null => {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { keepRecent, minChars, headChars, tailChars } = opts;
	const isToolResult = (m: unknown): m is Record<string, unknown> =>
		!!m && typeof m === "object" && (m as Record<string, unknown>).role === "toolResult";

	const toolResultIdx: number[] = [];
	for (let i = 0; i < messages.length; i++) if (isToolResult(messages[i])) toolResultIdx.push(i);
	if (toolResultIdx.length === 0) return null;

	// Todo salvo los últimos keepRecent tool results se puede limpiar.
	const clearable = toolResultIdx.slice(0, Math.max(0, toolResultIdx.length - Math.max(0, keepRecent)));
	if (clearable.length === 0) return null;
	// Nunca limpies salvo que el inicio+final que conservamos sea estrictamente menor que el texto.
	const minEffective = Math.max(minChars, headChars + tailChars + 1);

	let changed = false;
	const out = messages.slice();
	for (const i of clearable) {
		const msg = messages[i] as Record<string, unknown>;
		if (msg.isError === true) continue; // conserva los fallos completos (señal de recuperación)
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		let blockChanged = false;
		const newContent = content.map((block: unknown) => {
			if (!block || typeof block !== "object") return block;
			const b = block as Record<string, unknown>;
			if (b.type !== "text" || typeof b.text !== "string") return block;
			const text = b.text;
			if (text.length <= minEffective || text.includes(CLEARED_SENTINEL)) return block;
			const head = text.slice(0, headChars);
			const tail = text.slice(text.length - tailChars);
			const removed = text.length - head.length - tail.length;
			const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
			blockChanged = true;
			return {
				...b,
				text: `${head}\n…${CLEARED_SENTINEL} ${removed} caracteres de este resultado de ${toolName} para ahorrar contexto; la salida completa se conserva en la sesión y se puede releer]…\n${tail}`,
			};
		});
		if (blockChanged) {
			out[i] = { ...msg, content: newContent };
			changed = true;
		}
	}
	return changed ? out : null;
};
