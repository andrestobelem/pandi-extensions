/**
 * Helpers puros para la tool `remember` invocable por el modelo: el lado de escritura de
 * pandi-local-memory. Se mantienen sin efectos colaterales (sin fs) para que la política de
 * agregado/deduplicación sea trivial de testear en aislamiento; index.ts se encarga del I/O real de archivos.
 *
 * Layout (estilo Claude): las notas durables viven bajo la CARPETA `.pi/memory/`.
 *   - `.pi/memory/MEMORY.md` es el ÍNDICE/punto de entrada, inyectado al inicio (capado).
 *   - `.pi/memory/<topic>.md` son archivos de TOPIC, leídos bajo demanda; nunca se autoinyectan.
 *
 * Restricción de diseño: Pi puede persistir notas durables POR SÍ SOLO, pero NUNCA debe
 * pisar contenido curado por humanos. Por eso cada nota escrita por el agente vive dentro
 * de un único BLOQUE GESTIONADO delimitado por marcadores de comentario HTML, siempre al
 * FINAL del archivo destino. Todo lo que queda fuera de los marcadores pertenece al humano y
 * se deja intacto byte por byte.
 *
 * Módulo hermano de profundidad 1 importado por index.ts vía "./memory.js"; verificado por tipos
 * de forma transitiva (tsconfig incluye extensions/**\/*.ts).
 */

/** Marcador que abre el bloque gestionado por el agente. */
export const REMEMBER_BEGIN = "<!-- pi:remember:begin -->";
/** Marcador que cierra el bloque gestionado por el agente. */
export const REMEMBER_END = "<!-- pi:remember:end -->";
/** Encabezado visible para quien lea MEMORY.md, para que el bloque gestionado sea obvio. */
export const MANAGED_HEADING = "## Memoria del agente (gestionada automáticamente por la tool remember)";

/** Límite superior para una sola nota (se recorta dentro de execute; nunca confíes en el modelo). */
export const MAX_NOTE_LENGTH = 1000;

function escapeRememberSentinels(note: string): string {
	return note.replace(/<!--\s*pi:remember:(begin|end)\s*-->/gi, (match) =>
		match.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
	);
}

/**
 * Normaliza una nota cruda en una sola línea limpia: colapsa espacios/saltos de línea,
 * recorta y limita la longitud. Devuelve "" cuando no queda nada para guardar.
 */
export function normalizeNote(raw: string): string {
	return escapeRememberSentinels(raw).replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH);
}

/** Quita el prefijo de viñeta `- <date>: ` para comparar dos notas solo por texto. */
function bulletNoteText(line: string): string {
	return line.replace(/^-\s+\d{4}-\d{2}-\d{2}:\s+/, "").trim();
}

function createManagedMemoryBlock(existing: string, bullet: string): string {
	const base = existing.replace(/\s+$/, "");
	const sep = base.length ? `${base}\n\n` : "";
	const block = `${REMEMBER_BEGIN}\n${MANAGED_HEADING}\n\n${bullet}\n${REMEMBER_END}\n`;
	return `${sep}${block}`;
}

function insertManagedMemoryBullet(existing: string, end: number, bullet: string): string {
	const head = existing.slice(0, end).replace(/\s+$/, "");
	const tail = existing.slice(end); // empieza con REMEMBER_END
	return `${head}\n${bullet}\n${tail}`;
}

/**
 * Agrega `note` (como viñeta fechada) al bloque gestionado de un documento MEMORY.md.
 *
 * - Si todavía no hay bloque gestionado → crea uno al FINAL (precedido por el contenido existente,
 *   si lo hay, para que las notas humanas queden arriba).
 * - Si el bloque gestionado existe → inserta la nueva viñeta justo antes del marcador END.
 * - Idempotente: si el texto exacto de la nota ya existe en el bloque gestionado, devuelve
 *   el documento sin cambios con `added: false`.
 *
 * Pura: devuelve el nuevo texto del documento; quien llama decide si lo escribe y dónde.
 */
export function upsertMemoryNote(existing: string, note: string, date: string): { content: string; added: boolean } {
	const bullet = `- ${date}: ${note}`;
	const begin = existing.indexOf(REMEMBER_BEGIN);
	const end = existing.indexOf(REMEMBER_END);
	const hasBlock = begin !== -1 && end !== -1 && end > begin;

	if (!hasBlock) return { content: createManagedMemoryBlock(existing, bullet), added: true };

	// Deduplica dentro del bloque gestionado (marcadores + encabezado + viñetas), comparando por el texto de la nota.
	const block = existing.slice(begin, end);
	const already = block.split("\n").some((line) => bulletNoteText(line) === note);
	if (already) return { content: existing, added: false };

	// Inserta la nueva viñeta justo antes del marcador END, conservando un solo salto de línea limpio.
	return { content: insertManagedMemoryBullet(existing, end, bullet), added: true };
}

// ===========================================================================
// Helpers del layout en carpeta (estilo Claude): un directorio `.pi/memory/` con un
// único ÍNDICE inyectado y archivos de topic bajo demanda. Todo es puro: quienes llaman
// desde index.ts resuelven esto contra cwd y se encargan del fs real.
// ===========================================================================

/** Directorio (relativo a `.pi/`) que guarda el índice de memoria y los archivos de topic. */
export const MEMORY_DIR = "memory";
/** Punto de entrada inyectado dentro de la carpeta de memoria. */
export const INDEX_FILE = "MEMORY.md";

/** Topes de inyección para el índice, igual que Claude: primeras 200 líneas O 25 KB. */
export const MAX_INJECT_LINES = 200;
export const MAX_INJECT_BYTES = 25_000;
/** Límite superior para la longitud del slug de topic, para que un título desbocado no genere un nombre enorme. */
export const MAX_SLUG_LENGTH = 64;

/**
 * Convierte un título de topic libre en un slug de filename seguro de un solo segmento.
 *
 * Colapsa cada secuencia no alfanumérica (incluyendo `/`, `\\`, `.`, `..`, espacios) a
 * un solo guion, pasa a minúsculas, recorta guiones y limita la longitud. Eso vuelve el
 * path traversal estructuralmente imposible: `"../../etc/passwd"` -> `"etc-passwd"`,
 * `"../"` -> `""`. Devuelve "" cuando no queda nada seguro (quien llama debe rechazarlo).
 */
export function slugifyTopic(raw: string): string {
	return raw
		.replace(/\.md$/i, "") // tolera que quien llama pase "debugging.md"
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH);
}

/** Recorta una string UTF-8 a lo sumo a `maxBytes`, quitando cualquier cola con codepoints partidos. */
function clipByBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return Buffer.from(text, "utf8")
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD+$/, ""); // quita un carácter de reemplazo final dejado por una secuencia multibyte cortada
}

/**
 * Recorta texto para la inyección: primero `maxLines` líneas y luego `maxBytes` bytes.
 * Devuelve el texto (posiblemente recortado) y si algo fue truncado.
 */
export function capForInjection(
	text: string,
	maxLines = MAX_INJECT_LINES,
	maxBytes = MAX_INJECT_BYTES,
): { text: string; truncated: boolean } {
	let truncated = false;
	const lines = text.split("\n");
	let out = text;
	if (lines.length > maxLines) {
		out = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		out = clipByBytes(out, maxBytes);
		truncated = true;
	}
	return { text: out, truncated };
}

/** Escapa tags literales de local_memory para que el contenido del archivo no pueda escaparse del delimitador. */
export function escapeLocalMemoryTags(text: string): string {
	return text.replace(/<\/?local_memory/gi, (match) => match.replace("<", "&lt;"));
}

/**
 * Construye el BODY totalmente escapado que se inyecta dentro del bloque <local_memory>: el
 * índice recortado, un marcador opcional de truncado y un listado de archivos de topic bajo
 * demanda (solo paths: sus contenidos NO se inyectan; el agente los lee con sus tools de archivos).
 */
export function composeInjectedMemory(args: {
	indexText: string;
	topicNames: string[];
	memoryDirPath: string;
}): string {
	const { text: capped, truncated } = capForInjection(args.indexText.trim());
	const parts = [capped];
	if (truncated) {
		parts.push("\n… (índice de memoria truncado para la inyección; abrí MEMORY.md para leer el resto)");
	}
	if (args.topicNames.length) {
		const list = args.topicNames.map((name) => `- ${args.memoryDirPath}/${name}`).join("\n");
		parts.push(`\n## Archivos de topics (se leen bajo demanda con tus tools de archivos)\n\n${list}`);
	}
	return escapeLocalMemoryTags(parts.join("\n"));
}
