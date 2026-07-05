/**
 * Datos puros y utilidades para el texto de estado juguetón de Pandi. Sin SDK, sin I/O,
 * sin aleatoriedad al cargar el módulo: importar este archivo no tiene efectos secundarios,
 * así que puede probarse en aislamiento (el index.ts de la extensión es la única capa de
 * orquestación).
 *
 * Contrato de tono: cada MOOD es un gerundio/frase breve y suave de "bosque de bambú" —
 * tierno y zen, con algún guiño dev sutil ("acomodando los bytes…", "rumiando los
 * tokens…"). Cada uno tiene que leerse natural en AMBAS plantillas que usa el indicador:
 *   `Pandi ${mood}`              p. ej. "Pandi trepando el bambú…"
 *   `Pandi despierto y ${mood}`  p. ej. "Pandi despierto y trepando el bambú…"
 * y cada uno termina con un único carácter de elipsis "…" (U+2026), en minúscula y sin
 * espacios extra.
 */

/**
 * Cita de splash de dos líneas que se muestra al iniciar (se deja tal cual; no es un
 * MOOD). El texto es un meme: la ortografía es intencional; no la "corrijas".
 */
export const PANDI_QUOTE = [
	"Pobres pandas, toda la vida masticando bambú…",
	"…lo que es yo, yo quiero todo el menú.",
] as const;

/** Gerundios juguetones que rotan por turno. Tono: tierno/zen del bosque de bambú. */
export const MOODS = [
	"rumiando bambú…",
	"masticando bambú…",
	"masticando ideas…",
	"pensando…",
	"tramando algo…",
	"haciendo cálculos pandescos…",
	"consultando al bosque de bambú…",
	"queriendo todo el menú…",
	"meditando bajo un árbol…",
	"estirándose al sol…",
	"buscando la mejor rama…",
	"acomodando los bytes…",
	"trepando el bambú…",
	"pelando un brote de bambú…",
	"siguiendo el rastro del bosque…",
	"ordenando ramas y hojas…",
	"olfateando ideas frescas…",
	"rumiando los tokens…",
	"contando anillos del bambú…",
	"respirando la brisa del bambudal…",
	"puliendo cada hoja…",
	"enroscado entre las ramas…",
] as const;

/**
 * Líneas tierno/zen de "otra cosa" que se muestran después de "Pandi listo." al iniciar
 * CUANDO el splash está visible, para que el saludo nunca repita la frase principal del
 * splash (PANDI_QUOTE). Tono: calma suave de bosque de bambú, oraciones completas (a
 * diferencia de los gerundios de MOOD), cada una terminada en "." o "…". Nunca repitas
 * PANDI_QUOTE acá.
 */
export const GREETINGS = [
	"El bosque respira tranquilo.",
	"Todo en calma en el bambudal.",
	"Sin apuro, como el bambú al crecer.",
	"Acá estoy, entre las ramas.",
	"Respirá hondo; empezamos cuando quieras.",
	"Que el bosque nos guíe hoy.",
	"Un brote fresco y a rumiar ideas.",
	"La brisa del bambudal nos acompaña.",
	"Paso a paso, hoja por hoja.",
	"Enroscados y en paz, listos para pensar.",
] as const;

/** Elige un elemento uniformemente aleatorio. Siempre devuelve un miembro de un array no vacío. */
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/**
 * Texto del saludo de arranque (la parte que va después de la cara animada). La cita de dos
 * líneas PANDI_QUOTE es trabajo del SPLASH, así que cuando el arte del splash está visible
 * NO debemos repetirla acá: el saludo es "Pandi listo." + una línea `flavor` tierno/zen
 * (elegí una de GREETINGS en el sitio de llamada para que este helper siga siendo
 * determinista). Cuando el splash está oculto (`/pandi art` off), el saludo lleva la cita
 * para que el meme siga apareciendo en algún lado.
 */
export const greetingText = (splashVisible: boolean, flavor: string): string =>
	splashVisible ? `Pandi listo. ${flavor}` : `Pandi listo. ${PANDI_QUOTE[0]} ${PANDI_QUOTE[1]}`;
