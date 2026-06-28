/**
 * Structured-output kernel for pi-dynamic-workflows.
 *
 * The structured-output system-prompt builder, a generic appendSystemPrompt helper,
 * and TypeBox-backed schema validation (validateStructuredData) + retry-prompt
 * formatting used when a subagent must return JSON. formatSchemaValidationErrors
 * stays module-private; index.ts imports back the 4 it calls inside runSubagent.
 *
 * One-way runtime dependency: index.ts -> structured-output. The back-edge to
 * index.ts is type-only (AgentOptions via import type, erased); Value comes from the
 * external typebox/value package and safeJson from the format.ts sibling (no cycle).
 * Extracted byte-identically from index.ts.
 */
import { Value } from "typebox/value";
import { safeJson } from "./format.js";
import type { AgentOptions } from "./index.js";

export function makeStructuredOutputSystemPrompt(schema: unknown): string {
	return [
		"You must respond with ONLY one valid JSON value that matches the JSON Schema below.",
		"Do not include Markdown fences, prose, comments, or any text outside the JSON value.",
		"If evidence is insufficient, still return a JSON value matching the schema and encode uncertainty inside the fields.",
		"JSON Schema:",
		safeJson(schema),
	].join("\n");
}

export function appendSystemPromptOption(options: AgentOptions, addition: string): AgentOptions {
	return {
		...options,
		appendSystemPrompt: options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${addition}` : addition,
	};
}

function formatSchemaValidationErrors(schema: unknown, data: unknown): string[] {
	try {
		const valueApi = Value as unknown as { Errors(schema: unknown, value: unknown): Iterable<unknown> };
		const errors = [...valueApi.Errors(schema, data)].slice(0, 8);
		return errors.map((error) => {
			if (!error || typeof error !== "object") return String(error);
			const record = error as Record<string, unknown>;
			const location = record.path ?? record.instancePath ?? record.schemaPath ?? "";
			const message = record.message ?? safeJson(record, 0);
			return `${location ? `${location}: ` : ""}${String(message)}`;
		});
	} catch (err) {
		return [`schema validation failed: ${err instanceof Error ? err.message : String(err)}`];
	}
}

export function validateStructuredData(schema: unknown, data: unknown): { ok: true } | { ok: false; errors: string[] } {
	try {
		const valueApi = Value as unknown as { Check(schema: unknown, value: unknown): boolean };
		if (valueApi.Check(schema, data)) return { ok: true };
		return { ok: false, errors: formatSchemaValidationErrors(schema, data) };
	} catch (err) {
		return { ok: false, errors: [`schema validation failed: ${err instanceof Error ? err.message : String(err)}`] };
	}
}

export function formatSchemaRetryPrompt(prompt: string, error: string): string {
	return `${prompt}\n\nThe previous response did not match the required JSON schema. Return ONLY a corrected JSON value, with no Markdown or prose. Validation errors:\n${error}`;
}
