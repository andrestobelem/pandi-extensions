import * as os from "node:os";
import * as path from "node:path";

export function expandHomePath(input: string): string {
	return input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
}

/** Resuelve una ruta de usuario contra el cwd de la sesión, expandiendo un `~` inicial. */
export function resolveUserPath(input: string, cwd: string): string {
	return path.resolve(cwd, expandHomePath(input));
}

/** Ruta de salida por defecto: la entrada con su extensión .md reemplazada por .html. */
export function defaultOutPath(inputAbs: string): string {
	return `${inputAbs.replace(/\.md$/i, "")}.html`;
}

export function relativeTo(cwd: string, abs: string): string {
	return path.relative(cwd, abs) || abs;
}
