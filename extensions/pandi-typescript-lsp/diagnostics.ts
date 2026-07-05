/**
 * pandi-typescript-lsp helpers: pure, UI-free logic for turning a `tsc --noEmit`
 * run into a bounded, touched-file diagnostics report.
 *
 * Everything here is deliberately free of pi's ExtensionContext / UI so it can be
 * unit-tested in isolation against the same bundle the extension ships. The only
 * side effects are filesystem reads (tsconfig / tsc discovery, realpath
 * canonicalization) — never a spawn. Spawning `tsc` (with an ARGV array, never a
 * shell string) lives in index.ts, mirroring how pandi-worktree keeps `runGit`
 * beside its pure helpers.
 *
 * Contract note: this is NOT a full Language Server. There is no hover, no
 * go-to-definition, no completions. The single contract is *diagnostics
 * feedback*: parse `tsc` output, keep only the files the turn actually touched,
 * and surface a top-N summary.
 *
 * Depth-one sibling module imported by index.ts via "./diagnostics.js".
 */

import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

/** Default wall-clock budget for a single `tsc` invocation. */
export const DEFAULT_TSC_TIMEOUT_MS = 60_000;

/** Default cap on how many diagnostics are surfaced in one report. */
export const DEFAULT_MAX_ERRORS = 20;

/** A single parsed `tsc` diagnostic. */
export interface Diagnostic {
	/** File path exactly as tsc emitted it (may be relative to tsc's cwd). */
	file: string;
	line: number;
	col: number;
	/** TypeScript error code, e.g. "TS2322". */
	code: string;
	severity: "error" | "warning";
	message: string;
}

/** Result of a single `tsc` spawn (returned by index.ts's runner). */
export interface TscRunResult {
	/** true when tsc exited 0 and was neither aborted nor timed out. */
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** set when we never managed to spawn tsc at all. */
	spawnError?: string;
}

/** How `tsc` should be invoked (command + leading args before the tsc flags). */
export interface TscCommand {
	/** Executable to spawn (node for env/local tsc.js, "npx" for the fallback). */
	command: string;
	/** Leading args (the tsc.js path for node, or ["tsc"] for npx). */
	args: string[];
	/** Which resolution branch produced this command (for diagnostics/tests). */
	kind: "env" | "local" | "npx";
}

/**
 * A TypeScript source file we care about: .ts/.tsx/.mts/.cts but NOT a .d.ts
 * declaration file (editing a .d.ts is rare and re-checking it adds noise).
 */
export function isTsFile(filePath: string): boolean {
	if (!filePath) return false;
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".d.ts")) return false;
	return /\.(ts|tsx|mts|cts)$/.test(lower);
}

/**
 * Parse `tsc --pretty false` output into structured diagnostics.
 *
 * Each diagnostic is a line of the form:
 *   `path/to/file.ts(line,col): error TSxxxx: message`
 * Handles CRLF, and folds INDENTED continuation lines (tsc wraps long messages)
 * into the preceding diagnostic's message. Non-matching, non-indented lines (e.g.
 * a trailing "Found N errors." summary) are ignored.
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
		// Indented, non-empty line that is not a new diagnostic → message continuation.
		if (current && /^\s+\S/.test(line)) {
			current.message += `\n${line.trim()}`;
		}
	}
	if (current) diags.push(current);
	return diags;
}

/** True when `dir` is `root` or a descendant of `root`. */
function isWithinOrEqual(root: string, dir: string): boolean {
	if (dir === root) return true;
	const rel = path.relative(root, dir);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Find the nearest tsconfig.json by walking UP from `file`'s directory, stopping
 * at `cwd` (inclusive). Falls back to `<cwd>/tsconfig.json` (whether or not it
 * exists) so callers always get a stable path to gate on with existsSync.
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

/** Build the tsc flag array for a project check. Pure; touches nothing. */
export function buildTscArgs(tsconfigPath: string): string[] {
	return ["--noEmit", "--pretty", "false", "-p", tsconfigPath];
}

/**
 * Resolve HOW to run tsc, in order:
 *   1. env PI_TS_LSP_TSC — absolute path to tsc.js, run with the current node.
 *   2. nearest node_modules/typescript/bin/tsc walking up from `tsconfigDir`.
 *   3. fallback: `npx tsc`.
 * Pure aside from existsSync probes; `env` is injectable for tests.
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
 * Canonicalize a path for comparison: resolve to absolute, then follow symlinks
 * via realpath when the path exists (so macOS /var ↔ /private/var and other
 * symlinked temp dirs compare equal). Falls back to the resolved path otherwise.
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
 * Stable 5-field dedupe key for a single diagnostic, given its already-canonical
 * file path. Used by both the touched-file filter and the feedback dedupe so the
 * key string stays identical in both places.
 */
function diagKey(canonicalFile: string, d: Diagnostic): string {
	return `${canonicalFile}:${d.line}:${d.col}:${d.code}:${d.message}`;
}

/**
 * Keep only diagnostics whose file is one of `touchedAbsPaths`, normalizing both
 * sides (realpath-aware) so symlinked temp dirs match, and de-duplicating
 * identical diagnostics. Returned diagnostics carry the canonical absolute path.
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

/** Result of formatting diagnostics for display. */
export interface FormatResult {
	hasErrors: boolean;
	text: string;
}

/**
 * Format diagnostics as a top-N list. Each line is
 *   `file(line,col): severity TSxxxx: message` (first line of the message only).
 * When there are more than `maxErrors`, a trailing `(+N más)` is appended.
 * `hasErrors` is true when any diagnostic has error severity.
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

/** Inputs to the run gate. `touched` is the COUNT of touched TS files. */
export interface ShouldRunState {
	touched: number;
	aborted: boolean;
	idle: boolean;
	pending: boolean;
}

/**
 * The coherent-edge gate: run only when the turn touched TS files, was not
 * aborted, the agent is idle, and nothing else is queued. Pure boolean logic.
 */
export function shouldRun(state: ShouldRunState): boolean {
	return state.touched > 0 && !state.aborted && state.idle && !state.pending;
}

/**
 * Stable, order-independent key for a set of diagnostics, used to DEDUPE feedback
 * so identical reports are not re-injected turn after turn.
 */
export function diagnosticsKey(diags: Diagnostic[]): string {
	return diags
		.map((d) => diagKey(canonicalize(d.file), d))
		.sort()
		.join("|");
}
