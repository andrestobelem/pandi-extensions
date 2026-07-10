/**
 * Tipos del modelo de grafo estático de workflows (introspección JS → steps/fanout/subworkflows).
 *
 * Hoja pura solo de tipos: sin runtime. graph-parse.js y workflow-graph.js importan desde aquí
 * para evitar el ciclo type↔runtime entre esos siblings. workflow-graph.ts reexporta por back-compat.
 */
import type { WorkflowDefinition } from "./types.js";

type WorkflowGraphStepKind =
	| "agent"
	| "artifact"
	| "barrier"
	| "fanout"
	| "file"
	| "pipeline"
	| "shell"
	| "subworkflow";

export type WorkflowGraphFanoutUnit = "agents" | "branches" | "lanes";

export interface WorkflowGraphFanoutInfo {
	unit: WorkflowGraphFanoutUnit;
	countLabel: string;
	count?: number;
	many: boolean;
	phaseLabel?: string;
	concurrency?: string;
	settle?: boolean;
	stages?: number;
}

export interface WorkflowGraphChildCall {
	method: string;
	/** Call-syntax prefix used in source: "ctx." for ctx-legacy calls, "" for globals-style. */
	prefix?: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
}

export interface WorkflowGraphStep {
	index: number;
	method: string;
	/** Call-syntax prefix used in source: "ctx." for ctx-legacy calls, "" for globals-style. */
	prefix?: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
	children: WorkflowGraphChildCall[];
	fanout?: WorkflowGraphFanoutInfo;
	subworkflow?: WorkflowGraphModel;
	subworkflowError?: string;
}

export interface WorkflowGraphCall extends WorkflowGraphChildCall {
	start: number;
	end: number;
	snippet: string;
}

export interface WorkflowGraphModel {
	workflow: WorkflowDefinition;
	steps: WorkflowGraphStep[];
	notes: string[];
}

export interface WorkflowGraphRenderTheme {
	accent(text: string): string;
	muted(text: string): string;
	success(text: string): string;
	warning(text: string): string;
}
