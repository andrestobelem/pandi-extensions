import * as fs from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWorkflowGraphModelWithSubworkflows, type WorkflowGraphModel } from "../lib/graph/index.js";
import { computeCodeHash } from "../runtime/index.js";
import type { WorkflowDefinition } from "../types.js";
import { resolveWorkflow } from "./resolve.js";
import { transformWorkflowCode } from "./transform.js";

export interface WorkflowPreflightResult {
	workflow: WorkflowDefinition;
	checks: string[];
	codeHash: string;
}

function workflowPreflightError(workflow: WorkflowDefinition, cause: string, fix: string): Error {
	const err = new Error(`Workflow preflight failed for ${workflow.name} (${workflow.path}): ${cause}. Fix: ${fix}`);
	err.name = "WorkflowPreflightError";
	return err;
}

function jsonSerializableProblem(value: unknown, label = "input", seen = new WeakSet<object>()): string | undefined {
	if (value === null) return undefined;
	const kind = typeof value;
	if (kind === "string" || kind === "boolean") return undefined;
	if (kind === "number") return Number.isFinite(value) ? undefined : `${label} must be a finite number`;
	if (kind === "undefined") return `${label} is undefined; use null or omit the field`;
	if (kind === "bigint") return `${label} is a bigint; convert it to a string or number`;
	if (kind === "function") return `${label} is a function; pass plain JSON data instead`;
	if (kind === "symbol") return `${label} is a symbol; pass plain JSON data instead`;
	if (kind !== "object") return `${label} is not JSON-serializable`;

	const object = value as object;
	if (seen.has(object)) return `${label} contains a circular reference; pass an acyclic JSON value`;
	seen.add(object);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const problem = jsonSerializableProblem(value[i], `${label}[${i}]`, seen);
			if (problem) return problem;
		}
		seen.delete(object);
		return undefined;
	}

	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
		return `${label} is ${ctor}; use a plain JSON object or array`;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const problem = jsonSerializableProblem(child, `${label}.${key}`, seen);
		if (problem) return problem;
	}
	seen.delete(object);
	return undefined;
}

function lineColumnAt(source: string, index: number): string {
	let line = 1;
	let column = 1;
	for (let i = 0; i < index; i++) {
		if (source[i] === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return `${line}:${column}`;
}

function isIdentifierChar(ch: string | undefined): boolean {
	return ch !== undefined && /[$_\p{ID_Continue}]/u.test(ch);
}

function findUnsupportedImportOrRequire(source: string): { pattern: string; index: number } | undefined {
	let quote: "'" | '"' | "`" | undefined;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		if (quote) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			const end = source.indexOf("\n", i + 2);
			if (end < 0) break;
			i = end;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) break;
			i = end + 1;
			continue;
		}
		if (source.startsWith("require", i) && !isIdentifierChar(source[i - 1]) && !isIdentifierChar(source[i + 7])) {
			let j = i + 7;
			while (/\s/.test(source[j] ?? "")) j++;
			if (source[j] === "(") return { pattern: "require(...)", index: i };
		}
		if (source.startsWith("import", i) && !isIdentifierChar(source[i - 1]) && !isIdentifierChar(source[i + 6])) {
			let j = i + 6;
			while (/\s/.test(source[j] ?? "")) j++;
			if (source[j] === "(") return { pattern: "import(...)", index: i };
		}
	}
	return undefined;
}

function firstBlockingSubworkflowError(model: WorkflowGraphModel): string | undefined {
	for (const step of model.steps) {
		if (
			step.subworkflowError &&
			!/dynamic sub-workflow name|nested sub-workflows|recursive sub-workflow skipped/i.test(step.subworkflowError)
		) {
			return `workflow() at line ${step.line} references ${step.firstArg ?? "a sub-workflow"}: ${step.subworkflowError}`;
		}
		if (step.subworkflow) {
			const child = firstBlockingSubworkflowError(step.subworkflow);
			if (child) return child;
		}
	}
	return undefined;
}

export function formatWorkflowPreflightSummary(result: WorkflowPreflightResult): string {
	return [
		`Workflow preflight passed: ${result.workflow.name}`,
		`File: ${result.workflow.path}`,
		`Code hash: ${result.codeHash}`,
		"Checks:",
		...result.checks.map((check) => `- ${check}`),
	].join("\n");
}

export async function preflightWorkflowLaunch(
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
): Promise<WorkflowPreflightResult> {
	const inputProblem = jsonSerializableProblem(input);
	if (inputProblem) {
		throw workflowPreflightError(
			workflow,
			inputProblem,
			"Pass only JSON-serializable args: plain objects, arrays, strings, numbers, booleans, or null.",
		);
	}

	let code: string;
	try {
		code = await fs.readFile(workflow.path, "utf8");
	} catch (err) {
		throw workflowPreflightError(
			workflow,
			`could not read workflow source: ${err instanceof Error ? err.message : String(err)}`,
			"Check that the workflow file exists and is readable.",
		);
	}

	const unsupported = findUnsupportedImportOrRequire(code);
	if (unsupported) {
		throw workflowPreflightError(
			workflow,
			`unsupported ${unsupported.pattern} at ${lineColumnAt(code, unsupported.index)}`,
			"Remove import/require and use the injected workflow globals (agent, agents, bash, readFile, workflow, args) instead.",
		);
	}

	let compiled: string;
	try {
		compiled = transformWorkflowCode(code);
	} catch (err) {
		throw workflowPreflightError(
			workflow,
			err instanceof Error ? err.message : String(err),
			"Use a top-level workflow script with injected globals and only optional `export const meta = { ... }`.",
		);
	}

	try {
		new Function("module", "exports", compiled);
	} catch (err) {
		throw workflowPreflightError(
			workflow,
			`syntax error: ${err instanceof Error ? err.message : String(err)}`,
			"Fix the JavaScript syntax before starting the workflow.",
		);
	}

	const graph = await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code, resolveWorkflow);
	const subworkflowError = firstBlockingSubworkflowError(graph);
	if (subworkflowError) {
		throw workflowPreflightError(
			workflow,
			subworkflowError,
			"Create the referenced sub-workflow, fix the workflow() name, or keep dynamic names explicit and handle runtime errors.",
		);
	}

	return {
		workflow,
		codeHash: computeCodeHash(code),
		checks: [
			"input is JSON-serializable",
			"source uses the supported workflow authoring contract",
			"source does not use import()/require()",
			"transformed workflow parses before run creation",
			"literal sub-workflow references are resolvable",
		],
	};
}
