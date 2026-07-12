/**
 * Chips de meta por fila de agente compartidos entre TUI (Monitor/Agents) y HTML run-report.
 * Centraliza el vocabulario compacto (`prompt✓`, `schema:ok`, `tools:N`, …) para evitar drift.
 */

export interface AgentRowMetaFields {
	promptAvailable?: boolean;
	schemaOk?: boolean;
	outputEmpty?: boolean;
	outputTruncated?: boolean;
	stdoutTruncated?: boolean;
	model?: string;
	thinking?: string;
	tools?: string | string[];
	skills?: string | string[];
	extensions?: string | string[];
	keys?: string | string[];
	missingKeys?: string | string[];
	includeSkills?: boolean;
	includeExtensions?: boolean;
	isolatedEnv?: boolean;
}

function listCount(value: string | string[] | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.length > 0 ? value.length : undefined;
	const count = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean).length;
	return count > 0 ? count : undefined;
}

export function shortAgentModel(model: string): string {
	return model.split("/").filter(Boolean).pop() ?? model;
}

export function buildAgentRowMetaChips(agent: AgentRowMetaFields): string[] {
	const toolCount = listCount(agent.tools);
	const skillCount = listCount(agent.skills);
	const extensionCount = listCount(agent.extensions);
	const keyCount = listCount(agent.keys);
	const missingCount = listCount(agent.missingKeys);
	return [
		agent.promptAvailable ? "prompt✓" : "prompt?",
		agent.schemaOk !== undefined ? `schema:${agent.schemaOk ? "ok" : "bad"}` : "",
		agent.outputEmpty ? "empty-output" : "",
		agent.outputTruncated ? "output:truncated" : "",
		agent.stdoutTruncated ? "stdout:truncated" : "",
		agent.model ? `model:${shortAgentModel(agent.model)}` : "",
		agent.thinking ? `effort:${agent.thinking}` : "",
		`tools:${toolCount ?? "default"}`,
		`skills:${skillCount ?? (agent.includeSkills === false ? "off" : "default")}`,
		`ext:${extensionCount ?? (agent.includeExtensions ? "default" : "off")}`,
		`keys:${keyCount ?? (agent.isolatedEnv ? "none" : "default")}`,
		missingCount ? `missing:${missingCount}` : "",
	].filter(Boolean);
}

export function agentRowMetaChipTone(label: string): "ok" | "warn" | "fail" | "" {
	if (label === "prompt✓" || label === "schema:ok") return "ok";
	if (label === "prompt?" || label.startsWith("missing:") || label.includes("truncated")) return "warn";
	if (label === "schema:bad" || label === "empty-output") return "fail";
	return "";
}
