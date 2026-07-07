/**
 * Comando `/rename` estilo Claude para Pi.
 *
 * El `/rename [name]` de Claude Code renombra la conversación actual: con un argumento
 * usa ese nombre, y sin argumento autogenera uno a partir del historial de la
 * conversación. Pi ya tiene un `/name <name>` nativo que fija el nombre visible de la sesión,
 * pero no tiene una ruta de autogeneración sin argumentos. Esta extensión agrega `/rename` como un
 * SUPERSET funcional de `/name` (coexiste con `/name`, nunca lo sobreescribe):
 *
 *   /rename Refactor auth   -> pi.setSessionName("refactor-auth")
 *   /rename "Hello World!"  -> pi.setSessionName("hello-world")
 *   /rename                 -> inventa un slug a partir de la actividad MÁS RECIENTE y lo aplica
 *                              directamente (sin diálogo); al volver a correrlo sigue el trabajo actual.
 *
 * Cada nombre aplicado es un slug. El nombre actual se muestra como una pastilla de color invertido
 * incrustada en el borde superior del editor (la línea violeta del prompt), justo donde
 * dynamic-workflows muestra "ultracode auto" — componiendo como "ultracode auto ── <slug>"
 * (etiqueta existente primero, nombre al final, unidos por la línea del borde) cuando ambas están presentes.
 * pandi-rename envuelve
 * el editor con su propia capa externa (delegando todo salvo render), así que no importa
 * ni depende de dynamic-workflows. La lógica de nombres es determinística y vive en
 * ./derive-name; la matemática del borde vive en ./border-label.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { composeTopBorder } from "./border-label.js";
import { DEFAULT_SESSION_NAME, slugify } from "./derive-name.js";
import { installExitNameHint } from "./exit-name-hint.js";
import { notify } from "./notify.js";
import { runPiSummary } from "./spawn-summary.js";
import { summarizeSessionName } from "./summarize-name.js";

const NAME_EDITOR_MARKER = "__piRenameNameBorderEditor";
const SET_PROVIDER = "__piRenameSetBorderProvider";

/** El editor envuelto creado más recientemente, al que se le pide redibujado tras un rename. */
let latestEditor: { invalidate?: () => void } | undefined;

/** Setter que alimenta la pista de salida "Nombre de sesión: <slug>" (undefined fuera de TTY). */
let setExitHintName: ((name: string | undefined) => void) | undefined;

function readEntries(ctx: ExtensionCommandContext): unknown[] {
	try {
		return ctx.sessionManager?.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

function safeName(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getSessionName();
	} catch {
		return undefined;
	}
}

/** La etiqueta de borde para el nombre actual de la sesión, o undefined cuando no tiene nombre. */
function borderLabel(pi: ExtensionAPI): string | undefined {
	return safeName(pi) || undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatRenameFailure(error: unknown): string {
	return `No se pudo renombrar la sesión: ${errorMessage(error)}`;
}

/** Convierte un nombre en slug y lo aplica vía pi.setSessionName, reportando éxito/falla. */
function applyName(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string): boolean {
	const finalName = slugify(rawName) || DEFAULT_SESSION_NAME;
	try {
		pi.setSessionName(finalName);
		setExitHintName?.(finalName);
		notify(ctx, `Sesión renombrada a "${finalName}".`, "info");
		// Forzá un redibujado del editor para que la etiqueta del borde se actualice enseguida.
		latestEditor?.invalidate?.();
		return true;
	} catch (error) {
		notify(ctx, formatRenameFailure(error), "error");
		return false;
	}
}

/**
 * Envuelve un editor con una capa externa transparente que solo sobreescribe render(), agregando la
 * etiqueta del nombre de sesión al borde superior. Todo lo demás delega en el editor base, así que
 * se preserva el comportamiento subyacente (tipeo, submit, dashboard con tecla Down de dynamic-workflows).
 * Un marker + un setter del provider permiten que install reutilice esta capa entre reloads.
 */
function wrapEditorWithNameBorder(
	base: EditorComponent,
	holder: { provider: () => string | undefined },
): EditorComponent {
	return new Proxy(base as object, {
		get(target, prop) {
			if (prop === NAME_EDITOR_MARKER) return true;
			if (prop === SET_PROVIDER) {
				return (next: () => string | undefined) => {
					holder.provider = next;
				};
			}
			if (prop === "render") {
				return (width: number): string[] => {
					const lines = (target as EditorComponent).render(width);
					const label = holder.provider();
					if (!label || lines.length === 0) return lines;
					const color = (target as { borderColor?: (value: string) => string }).borderColor ?? ((s) => s);
					// El nombre se renderiza como una "pastilla": fg/bg invertidos (reverse video) sobre el color del borde.
					const labelColor = (value: string) => `\x1b[7m${color(value)}\x1b[27m`;
					const decorated = composeTopBorder(lines[0], width, label, { color, labelColor });
					if (decorated == null) return lines;
					const out = [...lines];
					out[0] = decorated;
					return out;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	}) as unknown as EditorComponent;
}

/** Instala (o reutiliza) la capa externa del editor que muestra el nombre en el borde superior. */
function installNameBorderLabel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return;
	const holder = { provider: () => borderLabel(pi) };
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const existing = base as {
			[NAME_EDITOR_MARKER]?: boolean;
			[SET_PROVIDER]?: (next: () => string | undefined) => void;
		};
		// Reutilizá nuestra propia capa entre reloads en vez de apilar otro proxy.
		if (existing[NAME_EDITOR_MARKER]) {
			existing[SET_PROVIDER]?.(holder.provider);
			latestEditor = base as { invalidate?: () => void };
			return base as EditorComponent;
		}
		const wrapped = wrapEditorWithNameBorder(base as EditorComponent, holder);
		latestEditor = wrapped as unknown as { invalidate?: () => void };
		return wrapped;
	});
}

export default function renameExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description:
			"Renombra la sesión actual con un slug. Sin argumento, resume tu actividad más reciente mediante el LLM.",
		handler: async (args, ctx) => {
			// Con un nombre, usalo directo (instantáneo, sin LLM). Nunca abre un diálogo de entrada.
			const trimmed = args.trim();
			if (trimmed) {
				applyName(pi, ctx, trimmed);
				return;
			}
			// Sin argumento: resumí la parte MÁS RECIENTE de la conversación en un nombre vía
			// `pi -p`, con respaldo en un slug determinístico del último mensaje si el LLM no está
			// disponible (offline, sin key, timeout). El handler ya es async.
			notify(ctx, "Generando un nombre a partir de la conversación reciente\u2026", "info");
			const { name, fellBack } = await summarizeSessionName({
				entries: readEntries(ctx),
				runSummary: (prompt) => runPiSummary(prompt, { cwd: ctx.cwd }),
				defaultName: DEFAULT_SESSION_NAME,
			});
			applyName(pi, ctx, name);
			if (fellBack) notify(ctx, "Se usó un nombre determinístico (resumen de conversación no disponible).", "info");
		},
	});

	// Mostrá el nombre actual en el borde superior del editor (solo TUI).
	pi.on("session_start", async (_event, ctx) => {
		installNameBorderLabel(pi, ctx);
		// Imprimí el nombre debajo de la pista de salida con UUID solamente de pi core (solo TUI; el
		// instalador mismo rechaza stdout no TTY, así que el modo print nunca se contamina).
		if (ctx.mode === "tui") {
			setExitHintName ??= installExitNameHint({
				isTTY: () => process.stdout.isTTY === true,
				onExit: (hook) => void process.on("exit", hook),
				write: (text) => void process.stdout.write(text),
			});
			setExitHintName?.(safeName(pi));
		}
	});

	// Seguí cada rename (nativo /name o de cualquier extensión) para que la pista de salida siga actualizada.
	// Los tipos fijados del SDK (0.80.2) van atrasados respecto del runtime acá: session_info_changed se emite
	// desde AgentSession en 0.80.2 y se tipa a partir de 0.80.3 — quitá el cast cuando la dep supere
	// min-release-age y se actualice.
	const onAny = pi.on as unknown as (
		event: string,
		handler: (event: { name?: string }, ctx: ExtensionContext) => Promise<void>,
	) => void;
	onAny("session_info_changed", async (event) => {
		setExitHintName?.(event.name);
	});
}
