/**
 * Pista del nombre de la sesión al salir.
 *
 * pi core imprime `To resume this session: pi --session <uuid>` justo antes de
 * `process.exit(0)` — siempre el UUID, nunca el nombre visible (upstream FR:
 * https://github.com/earendil-works/pi/issues/6296). Un hook de `exit` del proceso corre
 * sincrónicamente DESPUÉS de esa escritura de core, así que este módulo usa uno para agregar una sola línea tenue
 * justo debajo cuando la sesión tiene nombre:
 *
 *   Session name: docs-html-mirror-sync (resume by name: pi -r)
 *
 * El estado mutable (nombre actual) vive en un holder registrado bajo un
 * Symbol global: `/reload` reimporta la extensión en un scope de módulo nuevo, y reutilizar
 * el holder registrado mantiene UN hook de salida (y una línea impresa) entre reloads
 * en vez de apilar un duplicado por reload. Si upstream publica #6296 esta línea
 * se vuelve redundante, pero sigue siendo inocua (imprime el mismo nombre).
 */

export const EXIT_HINT_KEY = Symbol.for("pandi-rename.exit-name-hint");

/** Superficie de proceso inyectada para que el comportamiento sea testeable sin un proceso real. */
export interface ExitNameHintIO {
	isTTY(): boolean;
	onExit(hook: () => void): void;
	write(text: string): void;
}

interface Holder {
	name: string | undefined;
}

/** La línea tenue de una sola línea impresa debajo de la pista de reanudación al salir de pi core. */
export function formatExitNameHint(name: string): string {
	const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
	return `${dim("Session name:")} ${name} ${dim("(resume by name: pi -r)")}\n`;
}

/**
 * Instala el hook de salida (o reutiliza el que registró una carga previa) y devuelve un
 * setter para el nombre actual de la sesión. Devuelve undefined fuera de TTY (stdout con pipe,
 * modo print), donde la línea contaminaría la salida legible por máquinas.
 */
export function installExitNameHint(
	io: ExitNameHintIO,
	registry: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): ((name: string | undefined) => void) | undefined {
	if (!io.isTTY()) return undefined;
	const makeSetter = (holder: Holder) => (name: string | undefined) => {
		holder.name = name?.trim() || undefined;
	};
	const existing = registry[EXIT_HINT_KEY] as Holder | undefined;
	if (existing) return makeSetter(existing);
	const holder: Holder = { name: undefined };
	registry[EXIT_HINT_KEY] = holder;
	io.onExit(() => {
		if (holder.name) io.write(formatExitNameHint(holder.name));
	});
	return makeSetter(holder);
}
