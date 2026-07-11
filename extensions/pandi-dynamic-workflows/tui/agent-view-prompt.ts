/**
 * Parsing y formateo Markdown del prompt y tablas de metadata en la vista de agente.
 */
import { MAX_TOOL_TEXT, truncate } from "../lib/format.js";
import type { AgentMonitorModel } from "../types.js";
import type { AgentPromptLinesInput, SettingRow } from "./agent-view-types.js";

export function extractMarkdownSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const knownHeadings = ["Access", "Prompt", "Structured Output", "Stdout", "Stderr"];
	const nextHeadings = knownHeadings
		.filter((candidate) => candidate !== heading)
		.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const nextPattern = nextHeadings.length ? `\\n## (?:${nextHeadings.join("|")})\\n` : "$^";
	const match = new RegExp(`(?:^|\\n)## ${escaped}\\n\\n([\\s\\S]*?)(?=${nextPattern}|$)`).exec(markdown);
	return match?.[1]?.trim();
}

export function fencedBlock(content: string, lang = "text"): string {
	const fence = content.includes("```") ? "````" : "```";
	return `${fence}${lang}\n${content}\n${fence}`;
}

function escapeMarkdownTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatSettingTable(rows: SettingRow[]): string {
	return [
		"| Setting | Value |",
		"| --- | --- |",
		...rows.map(([key, value]) => `| ${escapeMarkdownTableCell(key)} | ${escapeMarkdownTableCell(value)} |`),
	].join("\n");
}

function describePromptSource(
	promptFromEvent: string | undefined,
	prompt: string | undefined,
	promptAvailable: boolean | undefined,
): string {
	if (promptFromEvent) return "event promptCopy";
	if (prompt) return "artifact Prompt section";
	return promptAvailable ? "artifact missing/unparsed" : "unavailable";
}

export function formatPromptText(
	promptSource: string | undefined,
	promptFromEvent: string | undefined,
	promptTruncated: boolean | undefined,
	promptAvailable: boolean | undefined,
): string {
	if (promptSource)
		return `${truncate(promptSource)}${promptFromEvent && promptTruncated ? "\n\n...[prompt copy truncated in events]" : ""}`;
	return promptAvailable
		? "Prompt artifact exists, but the prompt section could not be parsed."
		: "Prompt not available for this run/agent.";
}

function isPromptSourceTruncated(
	promptSource: string | undefined,
	promptFromEvent: string | undefined,
	promptTruncated: boolean | undefined,
): boolean {
	return !!promptSource && (promptSource.length > MAX_TOOL_TEXT || !!(promptFromEvent && promptTruncated));
}

export function formatPromptMetadataRows(
	agent: AgentMonitorModel,
	agentRef: string,
	stateIcon: string,
	promptSourceLabel: string,
	promptSource: string | undefined,
	promptWasTruncated: boolean,
	artifactPath: string | undefined,
): SettingRow[] {
	return [
		["Agent", `${agentRef} ${agent.name}`],
		["State", `${stateIcon} ${agent.state}`],
		["Source", promptSourceLabel],
		["Characters", promptSource ? `${promptSource.length} source` : "n/a"],
		["Truncated", promptWasTruncated ? "yes" : "no"],
		["Artifact", artifactPath ?? "unavailable"],
	];
}

export function formatAgentPromptLines({
	agentRef,
	agentName,
	promptTable,
	promptText,
	access,
}: AgentPromptLinesInput): string[] {
	return [
		`# Prompt: Agent ${agentRef}: ${agentName}`,
		"",
		"## Summary",
		"",
		promptTable,
		"",
		"## Prompt body",
		"",
		promptText,
		...(access ? ["", "## Runtime access", "", truncate(access, 6000)] : []),
	];
}

export function resolvePromptPresentation(
	agent: AgentMonitorModel,
	promptFromEvent: string | undefined,
	prompt: string | undefined,
	agentRef: string,
	stateIcon: string,
	artifactPath: string | undefined,
): { promptSourceLabel: string; promptWasTruncated: boolean; promptText: string; promptTable: string } {
	const promptSource = promptFromEvent ?? prompt;
	const promptText = formatPromptText(promptSource, promptFromEvent, agent.promptTruncated, agent.promptAvailable);
	const promptSourceLabel = describePromptSource(promptFromEvent, prompt, agent.promptAvailable);
	const promptWasTruncated = isPromptSourceTruncated(promptSource, promptFromEvent, agent.promptTruncated);
	const promptRows = formatPromptMetadataRows(
		agent,
		agentRef,
		stateIcon,
		promptSourceLabel,
		promptSource,
		promptWasTruncated,
		artifactPath,
	);
	return {
		promptSourceLabel,
		promptWasTruncated,
		promptText,
		promptTable: formatSettingTable(promptRows),
	};
}
