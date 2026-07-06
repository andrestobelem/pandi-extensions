export const NO_UI_MESSAGE =
	"Error: la UI interactiva no está disponible (modo no interactivo). Preguntale al usuario en texto plano.";

export function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

export function jsonResult(payload: unknown, details: unknown) {
	return textResult(JSON.stringify(payload), details);
}
