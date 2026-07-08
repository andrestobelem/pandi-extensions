/**
 * Helpers puros para incrustar una etiqueta alineada a la derecha en el borde superior del editor (la línea violeta
 * del prompt), reflejando cómo el editor de dynamic-workflows muestra "ultracode auto".
 *
 * Sin imports: un pequeño removedor ANSI vendorizado y un ancho basado en longitud alcanzan para los
 * slugs ASCII + un par de símbolos que renderizamos. composeTopBorder() es determinística y está
 * testeada; index.ts se ocupa del wrapping (impuro) del editor.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
const DASH = "─";

export function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

export function visibleWidth(value: string): number {
	return stripAnsi(value).length;
}

export interface ComposeDeps {
	/** Envuelve los guiones (y cualquier etiqueta existente) con el color del borde del editor. Por defecto: identidad. */
	color?: (value: string) => string;
	/** Estiliza la etiqueta del nombre, p. ej. una "pastilla" con fg/bg invertido. Por defecto: igual que color. */
	labelColor?: (value: string) => string;
}

interface ParsedTopBorder {
	existing: string;
	isDecorable: boolean;
}

function parseTopBorder(line0: string): ParsedTopBorder {
	const plain = stripAnsi(line0);
	if (/^─+$/.test(plain)) {
		return { existing: "", isDecorable: true };
	}

	const match = plain.match(/^(─+) (.+) (─+)$/);
	if (!match) {
		return { existing: "", isDecorable: false };
	}

	const leftDashes = match[1].length;
	const rightDashes = match[3].length;
	// Una etiqueta alineada a la derecha (p. ej. ultracode) tiene pocos guiones finales; una pista
	// alineada a la izquierda (p. ej. "↑ N more") tiene muchos. Solo combinar con una etiqueta alineada a la derecha.
	if (rightDashes > leftDashes) {
		return { existing: "", isDecorable: false };
	}

	return { existing: match[2].trim(), isDecorable: true };
}

/**
 * Alinea a la derecha la etiqueta del nombre dentro de una línea de borde superior. Cualquier etiqueta alineada a la derecha
 * existente (p. ej. "ultracode auto") se conserva y se coloca PRIMERO, con el nombre al final, unida por el glifo
 * del borde para que la línea continúe dentro de la pastilla del nombre. El nombre se estiliza con
 * labelColor (su propia pastilla), el resto con color. Devuelve la línea reconstruida, o null cuando la línea no es un borde
 * decorable — una pista alineada a la izquierda como un indicador de scroll ("↑ N more") o cualquier cosa que no
 * parsee como borde se deja intacta, y se devuelve null cuando no hay suficiente espacio.
 */
export function composeTopBorder(line0: string, width: number, label: string, deps: ComposeDeps = {}): string | null {
	if (!line0 || width <= 0 || !label) return null;
	const color = deps.color ?? ((value: string) => value);
	const labelColor = deps.labelColor ?? color;
	const parsed = parseTopBorder(line0);
	if (!parsed.isDecorable) return null;

	// Conectá la etiqueta existente con el nombre usando el MISMO glifo de borde (─), para que la línea
	// continúe sin cortes dentro de la pastilla del nombre en vez de usar un separador ASCII espaciado.
	const pill = ` ${label} `;
	const joiner = ` ${DASH}${DASH}`;
	const visibleMiddle = parsed.existing ? ` ${parsed.existing}${joiner}${pill}` : pill;
	const styledMiddle = parsed.existing ? color(` ${parsed.existing}${joiner}`) + labelColor(pill) : labelColor(pill);

	const rightDashes = 2;
	const leftDashes = width - visibleWidth(visibleMiddle) - rightDashes;
	if (leftDashes < 2) return null;
	return color(DASH.repeat(leftDashes)) + styledMiddle + color(DASH.repeat(rightDashes));
}
