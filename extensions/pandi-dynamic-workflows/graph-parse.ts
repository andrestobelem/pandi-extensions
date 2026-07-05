/**
 * Núcleo de introspección de fuente de workflow-graph para pandi-dynamic-workflows.
 *
 * Análisis estático puro de fuente JavaScript de workflows: sanitización de labels,
 * extracción de string-literal / argumentos de llamada, separación de argumentos top-level e
 * inferencia de fanout/cardinalidad que convierte llamadas ctx.* en metadata de pasos del graph.
 *
 * Dependencia runtime unidireccional: importa renderSafeInline desde la hoja render-utils;
 * la referencia de vuelta a index.ts es SOLO DE TIPOS (import type, borrada en build), así
 * no hay ciclo runtime. Extraído byte-idéntico desde index.ts.
 */
import { renderSafeInline } from "./render-utils.js";
import type { WorkflowGraphChildCall, WorkflowGraphFanoutInfo, WorkflowGraphStep } from "./workflow-graph.js";

export function mermaidLabel(value: string): string {
	return (
		value
			.replace(/["<>{}[\]()|]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 90) || "step"
	);
}

export function graphTextLabel(value: string): string {
	return renderSafeInline(value).slice(0, 96) || "step";
}

export function extractFirstStringLiteral(source: string): string | undefined {
	const match = /(?:`([^`]{1,160})`|"([^"\n]{1,160})"|'([^'\n]{1,160})')/.exec(source);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function extractDirectStringLiteralArgument(source: string): string | undefined {
	const trimmed = source.trim();
	const match = /^(?:`([^`$]{1,200})`|"([^"\n]{1,200})"|'([^'\n]{1,200})')\s*$/s.exec(trimmed);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function isJavaScriptCodePosition(source: string, index: number): boolean {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < index; i++) {
		const char = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
	}
	return !quote && !lineComment && !blockComment;
}

export function lineNumberAtIndex(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (source.charCodeAt(i) === 10) line++;
	}
	return line;
}

export function findCallEndIndex(source: string, openParenIndex: number): number {
	let depth = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = openParenIndex; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return Math.min(source.length, openParenIndex + 320);
}

export function splitTopLevelArguments(source: string): string[] {
	const args: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) {
			const arg = source.slice(start, i).trim();
			if (arg) args.push(arg);
			start = i + 1;
		}
	}
	const tail = source.slice(start).trim();
	if (tail) args.push(tail);
	return args;
}

function compactExpressionLabel(value: string, max = 64): string {
	return value.replace(/\s+/g, " ").replace(/,$/, "").trim().slice(0, max) || "dynamic";
}

function countTopLevelArrayItems(expression: string): number | undefined {
	const trimmed = expression.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return 0;
	return splitTopLevelArguments(inner).length;
}

function inferCollectionCardinality(
	expression: string,
	fallbackLabel: string,
): Pick<WorkflowGraphFanoutInfo, "count" | "countLabel" | "many"> {
	const trimmed = expression.trim();
	const literalCount = countTopLevelArrayItems(trimmed);
	if (literalCount !== undefined)
		return { count: literalCount, countLabel: String(literalCount), many: literalCount > 1 };
	const mapMatch = /^(.+?)\.map\s*\(/s.exec(trimmed);
	if (mapMatch) {
		const source = compactExpressionLabel(mapMatch[1], 48);
		return { countLabel: `${source}.length`, many: true };
	}
	if (/\.length\b/.test(trimmed)) return { countLabel: compactExpressionLabel(trimmed, 48), many: true };
	if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\?\.[A-Za-z_$][\w$]*)*$/.test(trimmed))
		return { countLabel: `${trimmed}.length`, many: true };
	return { countLabel: fallbackLabel, many: true };
}

function extractObjectOptionValue(options: string | undefined, key: string): string | undefined {
	if (!options) return undefined;
	const property = new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`).exec(options);
	if (property) return compactExpressionLabel(property[1], 32);
	const shorthand = new RegExp(`(?:^|[{,]\\s*)${key}(?:\\s*[,}])`).exec(options);
	return shorthand ? key : undefined;
}

function extractObjectBooleanOption(options: string | undefined, key: string): boolean | undefined {
	const raw = extractObjectOptionValue(options, key);
	if (raw === "true") return true;
	if (raw === "false") return false;
	return undefined;
}

export function inferWorkflowGraphFanout(
	method: string,
	args: string[],
	phaseIndex: number | undefined,
): WorkflowGraphFanoutInfo | undefined {
	const firstArg = args[0] ?? "";
	const options = args[1];
	if (method === "agents") {
		const cardinality = inferCollectionCardinality(firstArg, "dynamic");
		return {
			unit: "agents",
			...cardinality,
			...(phaseIndex ? { phaseLabel: `P${phaseIndex}` } : {}),
			...(extractObjectOptionValue(options, "concurrency")
				? { concurrency: extractObjectOptionValue(options, "concurrency") }
				: {}),
			...(extractObjectBooleanOption(options, "settle") === undefined
				? {}
				: { settle: extractObjectBooleanOption(options, "settle") }),
		};
	}
	if (method === "parallel") {
		const cardinality = inferCollectionCardinality(firstArg, "dynamic");
		return { unit: "branches", ...cardinality };
	}
	if (method === "pipeline") {
		const cardinality = inferCollectionCardinality(firstArg, "dynamic");
		return { unit: "lanes", ...cardinality, stages: Math.max(0, args.length - 1) };
	}
	return undefined;
}

export function formatWorkflowGraphFanoutSummary(fanout: WorkflowGraphFanoutInfo): string {
	const parts = [`×${fanout.countLabel} ${fanout.unit}`];
	if (fanout.phaseLabel) parts.unshift(fanout.phaseLabel);
	if (fanout.stages !== undefined) parts.push(`${fanout.stages} stages`);
	if (fanout.concurrency)
		parts.push(fanout.concurrency === "concurrency" ? "concurrency" : `concurrency=${fanout.concurrency}`);
	if (fanout.settle !== undefined) parts.push(`settle:${fanout.settle}`);
	return parts.join(" · ");
}

export function summarizeWorkflowGraphChildren(children: WorkflowGraphChildCall[]): string | undefined {
	if (children.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const child of children) {
		const display = `${child.prefix ?? "ctx."}${child.method}`;
		counts.set(display, (counts.get(display) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([display, count]) => `${count}× ${display}`)
		.join(", ");
}

export function workflowGraphMethodInfo(
	method: string,
): Omit<WorkflowGraphStep, "index" | "label" | "line" | "firstArg" | "children" | "fanout"> {
	if (method === "agents") return { method, kind: "fanout", symbol: "◆", title: "fan-out subagents" };
	if (method === "parallel") return { method, kind: "barrier", symbol: "⧉", title: "parallel barrier" };
	if (method === "pipeline") return { method, kind: "pipeline", symbol: "▣", title: "pipeline lanes" };
	if (method === "agent") return { method, kind: "agent", symbol: "●", title: "subagent" };
	if (method === "workflow") return { method, kind: "subworkflow", symbol: "◇", title: "sub-workflow" };
	if (method === "bash") return { method, kind: "shell", symbol: "$", title: "bash" };
	if (method === "writeArtifact" || method === "appendArtifact")
		return {
			method,
			kind: "artifact",
			symbol: "▤",
			title: method === "writeArtifact" ? "write artifact" : "append artifact",
		};
	return {
		method,
		kind: "file",
		symbol: "◌",
		title: method.replace(/[A-Z]/g, (char) => ` ${char.toLowerCase()}`),
	};
}
