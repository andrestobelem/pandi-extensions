/**
 * Utilidades de pandi-typescript-lsp: lógica pura, sin UI, para convertir una
 * corrida de `tsc --noEmit` en un reporte acotado de diagnósticos para archivos
 * tocados.
 *
 * Todo acá está deliberadamente libre de ExtensionContext / UI de pi para poder
 * probarse de forma aislada contra el mismo bundle que publica la extensión. Los
 * únicos efectos laterales son lecturas del filesystem (descubrimiento de
 * tsconfig / tsc, canonicalización con realpath); nunca un spawn. El spawn de
 * `tsc` (con un array ARGV, nunca un shell string) vive en index.ts, reflejando
 * cómo pandi-worktree mantiene `runGit` junto a sus utilidades puras.
 *
 * Nota de contrato: esto NO es un Language Server completo. No hay hover,
 * go-to-definition ni completions. El único contrato es el *feedback de
 * diagnósticos*: parsear la salida de `tsc`, conservar solo los archivos que el
 * turno realmente tocó y mostrar un resumen top-N.
 *
 * Módulo hermano a un nivel, importado por index.ts vía "./diagnostics.js".
 */

import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

/** Presupuesto predeterminado de tiempo real para una sola invocación de `tsc`. */
export const DEFAULT_TSC_TIMEOUT_MS = 60_000;

/** Tope predeterminado de diagnósticos que se muestran en un reporte. */
export const DEFAULT_MAX_ERRORS = 20;

/** Un solo diagnóstico parseado de `tsc`. */
export interface Diagnostic {
	/** Ruta de archivo exactamente como la emitió tsc (puede ser relativa al cwd de tsc). */
	file: string;
	line: number;
	col: number;
	/** Código de error de TypeScript, por ejemplo "TS2322". */
	code: string;
	severity: "error" | "warning";
	message: string;
}

/** Resultado de un solo spawn de `tsc` (devuelto por el ejecutor de index.ts). */
export interface TscRunResult {
	/** true cuando tsc salió con 0 y no fue ni abortado ni agotó el tiempo. */
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** Se define cuando nunca logramos hacer spawn de tsc. */
	spawnError?: string;
}

/** Cómo debe invocarse `tsc` (comando + args iniciales antes de los flags de tsc). */
export interface TscCommand {
	/** Ejecutable a spawnear (node para env/local tsc.js, "npx" para el respaldo). */
	command: string;
	/** Args iniciales (la ruta a tsc.js para node, o ["tsc"] para npx). */
	args: string[];
	/** Qué rama de resolución produjo este comando (para diagnósticos/tests). */
	kind: "env" | "local" | "npx";
}

function hasFilePath(filePath: string): boolean {
	return Boolean(filePath);
}

/**
 * Un archivo fuente TypeScript que nos importa: .ts/.tsx/.mts/.cts, pero NO un
 * archivo de declaración .d.ts (editar un .d.ts es raro y volver a chequearlo
 * agrega ruido).
 */
export function isTsFile(filePath: string): boolean {
	if (!hasFilePath(filePath)) return false;
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".d.ts")) return false;
	return /\.(ts|tsx|mts|cts)$/.test(lower);
}

/**
 * Parsea la salida de `tsc --pretty false` en diagnósticos estructurados.
 *
 * Cada diagnóstico es una línea con la forma:
 *   `path/to/file.ts(line,col): error TSxxxx: message`
 * Maneja CRLF y pliega las líneas de continuación indentadas (tsc parte mensajes
 * largos) dentro del mensaje del diagnóstico anterior. Las líneas que no matchean
 * y no están indentadas (por ejemplo, un resumen final "Found N errors.") se
 * ignoran.
 */
export function parseTscDiagnostics(stdout: string): Diagnostic[] {
	const diags: Diagnostic[] = [];
	if (!stdout) return diags;
	const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
	let current: Diagnostic | null = null;
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const match = re.exec(line);
		if (match) {
			if (current) diags.push(current);
			current = {
				file: match[1],
				line: Number(match[2]),
				col: Number(match[3]),
				severity: match[4] as "error" | "warning",
				code: match[5],
				message: match[6],
			};
			continue;
		}
		// Línea indentada, no vacía, que no es un diagnóstico nuevo → continuación del mensaje.
		if (current && /^\s+\S/.test(line)) {
			current.message += `\n${line.trim()}`;
		}
	}
	if (current) diags.push(current);
	return diags;
}

/** Devuelve true cuando `dir` es `root` o un descendiente de `root`. */
function isWithinOrEqual(root: string, dir: string): boolean {
	if (dir === root) return true;
	const rel = path.relative(root, dir);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Encuentra el tsconfig.json más cercano recorriendo hacia ARRIBA desde el
 * directorio de `file`, y se detiene en `cwd` (inclusive). Usa
 * `<cwd>/tsconfig.json` como respaldo (exista o no) para que quienes llaman
 * siempre obtengan una ruta estable sobre la que puedan decidir con existsSync.
 */
export function findNearestTsconfig(file: string, cwd: string): string {
	const root = path.resolve(cwd);
	const fallback = path.join(root, "tsconfig.json");
	let dir = path.dirname(path.resolve(file));
	if (!isWithinOrEqual(root, dir)) return fallback;
	for (;;) {
		const candidate = path.join(dir, "tsconfig.json");
		if (existsSync(candidate)) return candidate;
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return fallback;
}

/** Construye el array de flags de tsc para un chequeo de proyecto. Puro; no toca nada. */
export function buildTscArgs(tsconfigPath: string): string[] {
	return ["--noEmit", "--pretty", "false", "-p", tsconfigPath];
}

/**
 * Resuelve CÓMO correr tsc, en este orden:
 *   1. env PI_TS_LSP_TSC — ruta absoluta a tsc.js, corrido con el node actual.
 *   2. el node_modules/typescript/bin/tsc más cercano, subiendo desde `tsconfigDir`.
 *   3. si no, `npx tsc`.
 * Es puro salvo por los sondeos con existsSync; `env` es inyectable para tests.
 */
export function resolveTscCommand(tsconfigDir: string, env: NodeJS.ProcessEnv = process.env): TscCommand {
	const envTsc = env.PI_TS_LSP_TSC?.trim();
	if (envTsc) return { command: process.execPath, args: [envTsc], kind: "env" };

	let dir = path.resolve(tsconfigDir);
	for (;;) {
		const candidate = path.join(dir, "node_modules", "typescript", "bin", "tsc");
		if (existsSync(candidate)) return { command: process.execPath, args: [candidate], kind: "local" };
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { command: "npx", args: ["tsc"], kind: "npx" };
}

/**
 * Canonicaliza una ruta para compararla: resolvela a absoluta y luego seguí los
 * symlinks con realpath cuando la ruta exista (así macOS /var ↔ /private/var y
 * otros directorios temporales con symlinks comparan igual). Si no, vuelve a la
 * ruta resuelta.
 */
function canonicalize(filePath: string): string {
	const abs = path.resolve(filePath);
	try {
		return realpathSync.native(abs);
	} catch {
		return abs;
	}
}

/**
 * Clave estable de dedupe de 5 campos para un solo diagnóstico, dada su ruta de
 * archivo ya canonicalizada. La usan tanto el filtro de archivos tocados como la
 * deduplicación de feedback para que el texto de la clave sea idéntico en ambos lados.
 */
function diagKey(canonicalFile: string, d: Diagnostic): string {
	return `${canonicalFile}:${d.line}:${d.col}:${d.code}:${d.message}`;
}

/**
 * Conserva solo los diagnósticos cuyo archivo esté en `touchedAbsPaths`,
 * normalizando ambos lados (con realpath) para que coincidan los temp dirs con
 * symlinks, y deduplicando diagnósticos idénticos. Los diagnósticos devueltos
 * llevan la ruta absoluta canonicalizada.
 */
export function filterToTouched(diags: Diagnostic[], touchedAbsPaths: string[]): Diagnostic[] {
	const touched = new Set(touchedAbsPaths.map(canonicalize));
	const seen = new Set<string>();
	const out: Diagnostic[] = [];
	for (const diag of diags) {
		const file = canonicalize(diag.file);
		if (!touched.has(file)) continue;
		const key = diagKey(file, diag);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ ...diag, file });
	}
	return out;
}

/** Resultado de formatear diagnósticos para mostrarlos. */
export interface FormatResult {
	hasErrors: boolean;
	text: string;
}

/**
 * Formatea diagnósticos como una lista top-N. Cada línea es
 *   `file(line,col): severity TSxxxx: message` (solo la primera línea del mensaje).
 * Cuando hay más de `maxErrors`, se agrega un `(+N más)` al final.
 * `hasErrors` es true cuando algún diagnóstico tiene severidad error.
 */
export function formatDiagnostics(diags: Diagnostic[], opts: { maxErrors?: number } = {}): FormatResult {
	const maxErrors = opts.maxErrors ?? DEFAULT_MAX_ERRORS;
	if (diags.length === 0) return { hasErrors: false, text: "" };
	const shown = diags.slice(0, Math.max(0, maxErrors));
	const lines = shown.map((d) => {
		const firstLine = d.message.split("\n")[0];
		return `${d.file}(${d.line},${d.col}): ${d.severity} ${d.code}: ${firstLine}`;
	});
	const extra = diags.length - shown.length;
	let text = lines.join("\n");
	if (extra > 0) text += `\n(+${extra} más)`;
	return { hasErrors: diags.some((d) => d.severity === "error"), text };
}

/** Entradas del criterio de ejecución. `touched` es la cantidad de archivos TS tocados. */
export interface ShouldRunState {
	touched: number;
	aborted: boolean;
	idle: boolean;
	pending: boolean;
}

/**
 * El criterio del borde coherente: corré solo cuando el turno tocó archivos TS,
 * no fue abortado, el agente está idle y no hay nada más en cola. Lógica booleana pura.
 */
export function shouldRun(state: ShouldRunState): boolean {
	return state.touched > 0 && !state.aborted && state.idle && !state.pending;
}

/**
 * Clave estable e independiente del orden para un conjunto de diagnósticos, usada
 * para deduplicar el feedback y evitar reinyectar reportes idénticos turno tras turno.
 */
export function diagnosticsKey(diags: Diagnostic[]): string {
	return diags
		.map((d) => diagKey(canonicalize(d.file), d))
		.sort()
		.join("|");
}
