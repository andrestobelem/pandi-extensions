/**
 * Capa externa del editor TUI que muestra el slug de sesión en el borde superior.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { composeTopBorder } from "./border-label.js";

const NAME_EDITOR_MARKER = "__piRenameNameBorderEditor";
const SET_PROVIDER = "__piRenameSetBorderProvider";

/** El editor envuelto creado más recientemente, al que se le pide redibujado tras un rename. */
let latestEditor: { invalidate?: () => void } | undefined;

export function invalidateNameBorder(): void {
	latestEditor?.invalidate?.();
}

function safeName(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getSessionName();
	} catch {
		return undefined;
	}
}

/** La etiqueta de borde para el nombre actual de la sesión, o undefined cuando no tiene nombre. */
export function borderLabel(pi: ExtensionAPI): string | undefined {
	return safeName(pi) || undefined;
}

/**
 * Envuelve un editor con una capa externa transparente que solo sobreescribe render(), agregando la
 * etiqueta del nombre de sesión al borde superior.
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
export function installNameBorderLabel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return;
	const holder = { provider: () => borderLabel(pi) };
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const existing = base as {
			[NAME_EDITOR_MARKER]?: boolean;
			[SET_PROVIDER]?: (next: () => string | undefined) => void;
		};
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

export { safeName };
