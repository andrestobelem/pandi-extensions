/**
 * Helpers puros y determinísticos para el comando `/rename`.
 *
 * Nunca tocan el LLM, la red ni ninguna API de Pi: dada la misma entrada
 * siempre devuelven el mismo nombre. El index.ts de la extensión es la única capa de
 * orquestación (lee la sesión, habla con la UI); toda la lógica de nombres vive acá para
 * poder testearse en aislamiento.
 *
 * Cada nombre producido acá es un slug: alfanuméricos ASCII en minúscula separados por
 * guiones simples, sin guiones iniciales/finales/repetidos.
 */

/** Nombre por defecto usado cuando no se puede derivar nada útil de la conversación. */
export const DEFAULT_SESSION_NAME = "session";

/** Límites base para un slug. Son ajustables; la suite de tests los pinea. */
export const MAX_NAME_CHARS = 60;
export const MAX_NAME_WORDS = 4;

/**
 * Palabras conectoras (artículos, preposiciones, conjunciones) con las que un nombre de sesión no debería terminar.
 * La idea es describir la sesión en pocas palabras sin dejar el slug colgando a mitad de frase
 * (p. ej. "arreglar-el-bug-de" -> "arreglar-el-bug"). Solo palabras funcionales de español + inglés;
 * las palabras de contenido nunca se recortan. En minúscula, ASCII, haciendo match con los tokens post-slugify.
 */
const TRAILING_CONNECTORS = new Set<string>([
	// Español
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"unos",
	"unas",
	"lo",
	"al",
	"del",
	"de",
	"a",
	"en",
	"con",
	"por",
	"para",
	"sin",
	"sobre",
	"entre",
	"hasta",
	"hacia",
	"desde",
	"ante",
	"tras",
	"y",
	"o",
	"u",
	"e",
	"ni",
	"que",
	"se",
	"su",
	"sus",
	"mi",
	"tu",
	// Inglés
	"the",
	"an",
	"of",
	"to",
	"for",
	"in",
	"on",
	"at",
	"by",
	"and",
	"or",
	"with",
	"from",
	"as",
	"is",
	"this",
	"that",
	"into",
	"onto",
]);

/**
 * Quita segmentos conectores finales de un slug con guiones para que un nombre nunca termine en
 * un artículo/preposición/conjunción colgando. Siempre conserva al menos un segmento, así que un
 * slug compuesto solo por conectores queda no vacío en vez de colapsar a "".
 */
function trimTrailingConnectors(slug: string): string {
	if (!slug) return slug;
	const parts = slug.split("-");
	while (parts.length > 1 && TRAILING_CONNECTORS.has(parts[parts.length - 1])) parts.pop();
	return parts.join("-");
}

export interface SlugOptions {
	maxChars?: number;
	maxWords?: number;
}

export interface DeriveOptions extends SlugOptions {
	defaultName?: string;
}

/**
 * Convierte texto arbitrario en un slug: quita diacríticos, pasa a minúscula, separa en cada racha
 * de caracteres no alfanuméricos y une las palabras con guiones. Trunca a lo sumo a maxWords
 * palabras y maxChars caracteres sin partir una palabra (una sola palabra demasiado grande se
 * trunca a la fuerza para que el resultado nunca quede vacío cuando había contenido), y luego quita
 * cualquier palabra conectora final para que el slug se lea como un nombre corto y nunca termine a mitad
 * de frase con un artículo/preposición/conjunción colgando. Devuelve "" cuando no hay nada
 * convertible a slug.
 */
export function slugify(raw: string, opts: SlugOptions = {}): string {
	const maxChars = opts.maxChars ?? MAX_NAME_CHARS;
	const maxWords = opts.maxWords ?? MAX_NAME_WORDS;
	const base = (raw ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // quita marcas diacríticas combinadas
		.toLowerCase();
	let words = base.split(/[^a-z0-9]+/).filter(Boolean);
	if (maxWords > 0) words = words.slice(0, maxWords);
	let slug = "";
	for (const word of words) {
		const candidate = slug ? `${slug}-${word}` : word;
		if (candidate.length > maxChars) break;
		slug = candidate;
	}
	// Si la primera palabra sola supera maxChars: truncá a la fuerza para seguir devolviendo un slug.
	if (!slug && words.length > 0) slug = words[0].slice(0, Math.max(0, maxChars));
	// Mantené el nombre corto, pero que nunca termine en una palabra conectora colgando.
	return trimTrailingConnectors(slug);
}

/** Extrae el contenido de texto unido de una entrada de mensaje `user` (ignora bloques de imagen). */
function extractUserText(entry: unknown): string {
	const message = (entry as { message?: { role?: string; content?: unknown } } | null)?.message;
	if (message?.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					!!block &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

/**
 * Deriva un nombre de sesión slug a partir del historial de la conversación, reflejando lo que el usuario está
 * haciendo AHORA. Recorre las entradas desde la MÁS RECIENTE hacia atrás y usa el último mensaje `user`
 * que produzca un slug no vacío (primero descarta un token inicial de slash-command,
 * así se saltea una invocación sola de `/rename` o un turno vacío y gana la instrucción real previa).
 * Como lee la actividad más reciente y no el primer mensaje, volver a llamar a `/rename`
 * mientras evoluciona la conversación produce un nombre fresco y actual
 * en vez de quedar clavado en cómo arrancó la sesión. Devuelve el nombre por defecto cuando ningún
 * mensaje del usuario produce un slug.
 */
export function deriveSessionName(entries: unknown, opts: DeriveOptions = {}): string {
	const fallback = opts.defaultName ?? DEFAULT_SESSION_NAME;
	const list = Array.isArray(entries) ? entries : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const raw = extractUserText(list[i]);
		if (!raw) continue;
		// Quitá un token inicial de slash-command, p. ej. "/explain the cache" -> "the cache".
		const cleaned = raw.replace(/^\s*\/[a-zA-Z][\w-]*\s*/, "");
		const slug = slugify(cleaned, opts);
		if (slug) return slug;
	}
	return fallback;
}
