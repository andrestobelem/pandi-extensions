/**
 * Bounded file reads y path helpers para el run report collector.
 * Ceilings por archivo, tail reads y containment checks relativos al run dir.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RunReportText } from "./html.js";

/** Límites — anclados a constantes runtime existentes (registro de diseño §4). */
export const REPORT_BOUNDS = {
	/** Matchea MAX_TOOL_TEXT / MAX_AGENT_OUTPUT_IN_RESULT. */
	outputChars: 24_000,
	/** Matchea el precedente readFilePrefix para reads de agent .md. */
	promptChars: 16_000,
	dataChars: 16_000,
	/** Tail, alineado con la magnitud 6 000-char stderr del TUI. */
	stderrTailChars: 6_000,
	logDetailChars: 500,
	/** Contenido inlined total en la página (elección conservadora). */
	globalInlineBudgetBytes: 1_000_000,
	/** Por-file read ceiling: dirs hostiles no pueden OOM el generador. */
	fileReadCeilingBytes: 4_000_000,
	maxArtifactsListed: 100,
} as const;

export async function readBounded(file: string, maxBytes: number): Promise<string | undefined> {
	try {
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/** Bounded TAIL read: open + seek a size − maxBytes (nunca lee el archivo entero). */
export async function readTail(file: string, maxBytes: number): Promise<string | undefined> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return undefined;
		const start = Math.max(0, stat.size - maxBytes);
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

export async function readJsonBounded<T>(file: string, maxBytes: number): Promise<T | undefined> {
	const body = await readBounded(file, maxBytes);
	if (body === undefined) return undefined;
	try {
		return JSON.parse(body) as T;
	} catch {
		return undefined;
	}
}

export function boundedText(value: string, max: number): RunReportText {
	return value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false };
}

/**
 * Recalcula un recorded (untrusted) path relativo al run dir. Los recorded paths son
 * either absolute (events.jsonl) o cwd-relative (el scan agents/ dir cuando el llamador
 * pasó un runDir relativo), así candidates se resuelven contra el CWD — nunca contra
 * el run dir, que duplicaría el prefijo para candidates relativos.
 */
export function containedRelative(runDir: string, candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	const resolvedRoot = path.resolve(runDir);
	const resolved = path.resolve(candidate);
	if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return undefined;
	const rel = path.relative(resolvedRoot, resolved);
	if (!rel || rel.startsWith("..")) return undefined;
	return rel.split(path.sep).join("/");
}

export function displayScriptPath(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const cwd = process.cwd();
	const resolved = path.resolve(file);
	if (resolved.startsWith(cwd + path.sep)) return path.relative(cwd, resolved).split(path.sep).join("/");
	return path.basename(resolved);
}

/** Segunda bounded events pass: agent estructurado `data` (readRunEvents mantiene solo output). */
export async function readAgentData(runDir: string, ceiling: number): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	const body = await readBounded(path.join(runDir, "events.jsonl"), ceiling);
	if (!body) return out;
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; id?: unknown; data?: unknown };
			if (event.type !== "agent" || typeof event.id !== "number" || event.data === undefined) continue;
			out.set(event.id, JSON.stringify(event.data, null, 2));
		} catch {
			// Líneas mal formadas se toleran en todas partes.
		}
	}
	return out;
}

export async function listArtifacts(
	runDir: string,
	max: number,
): Promise<{ artifacts: { path: string; bytes?: number }[]; omitted: number }> {
	const found: { path: string; bytes?: number }[] = [];
	const walk = async (dir: string, rel: string): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				// Nunca siga dirs symlinked fuera del run dir.
				if (!entry.isSymbolicLink()) await walk(path.join(dir, entry.name), childRel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (childRel === "report.html" || childRel === "artifact-viewer.html") continue; // los viewers nunca se listan a sí mismos
			let bytes: number | undefined;
			try {
				bytes = (await fs.stat(path.join(dir, entry.name))).size;
			} catch {
				bytes = undefined;
			}
			found.push({ path: childRel, ...(bytes === undefined ? {} : { bytes }) });
		}
	};
	await walk(runDir, "");
	found.sort((a, b) => a.path.localeCompare(b.path));
	return { artifacts: found.slice(0, max), omitted: Math.max(0, found.length - max) };
}
