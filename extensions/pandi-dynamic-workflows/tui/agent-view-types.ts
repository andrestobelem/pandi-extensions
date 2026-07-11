/**
 * Tipos compartidos para el formateo de la vista de detalle de agente (Card / Prompt / Output).
 */
import type { parsePiJsonModeOutput } from "../runtime/index.js";
import type { AgentMonitorModel, WorkflowRunRecord } from "../types.js";

export type ParsedPiStdout = ReturnType<typeof parsePiJsonModeOutput>;
export type SettingRow = [string, string];

export type AgentSummaryFormatInput = {
	run: WorkflowRunRecord;
	agent: AgentMonitorModel;
	agentRef: string;
	stateIcon: string;
	phase: string | undefined;
	artifactPath: string | undefined;
	artifactError: string;
};

export type AgentOutputLinesInput = {
	outputText: string;
	structuredOutput: string | undefined;
	stdoutNote: string | undefined;
	liveStdoutPath: string | undefined;
	liveStderrPath: string | undefined;
	stderr: string | undefined;
	liveStderr: string;
};

export type AgentPromptLinesInput = {
	agentRef: string;
	agentName: string;
	promptTable: string;
	promptText: string;
	access: string | undefined;
};

export type AgentArtifactSections = {
	access: string | undefined;
	prompt: string | undefined;
	stdout: string | undefined;
	stderr: string | undefined;
	structuredOutput: string | undefined;
};

// La vista de detalle se parte en sub-tabs (Card / Prompt / Output) más el documento
// legacy concatenado (`full`, usado por print mode y rutas no-TUI).
export interface AgentViewParts {
	card: string;
	prompt: string;
	output: string;
	full: string;
}
