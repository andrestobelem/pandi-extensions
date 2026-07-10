import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sleep } from "../lib/concurrency.js";
import { MAX_TOOL_TEXT, stringify } from "../lib/format.js";
import { resolveCwdPath } from "../lib/path-safety.js";
import { ensureDir } from "../lib/paths.js";
import type { RunLimits, SubagentResult } from "../types.js";
import { makeRunAgents } from "./agents.js";
import type { WorkflowRuntimeApi } from "./api.js";
import { type BashAskContext, runAsk, runBash } from "./bash-ask.js";
import type { InternalAgentOptions } from "./subagent.js";

export type MakeApiDeps = {
	ctx: ExtensionContext;
	runId: string;
	runDir: string;
	runLimits: Readonly<RunLimits>;
	runSignal: { signal: AbortSignal };
	agent: (prompt: string, options?: InternalAgentOptions) => Promise<SubagentResult>;
	getAgentPhaseCount: () => number;
	bumpAgentPhaseCount: () => number;
	getFanoutSignal: () => AbortSignal;
	runSubworkflow: (name: string, input?: unknown) => Promise<unknown>;
	bashAsk: BashAskContext;
	log: WorkflowRuntimeApi["log"];
	phase: WorkflowRuntimeApi["phase"];
	writeArtifact: WorkflowRuntimeApi["writeArtifact"];
	appendArtifact: WorkflowRuntimeApi["appendArtifact"];
};

export function makeApi(
	deps: MakeApiDeps,
	workflowNamespace: string | undefined,
	allowWorkflow: boolean,
	apiInput: unknown,
): WorkflowRuntimeApi {
	const {
		ctx,
		runId,
		runDir,
		runLimits,
		runSignal,
		agent,
		bumpAgentPhaseCount,
		getFanoutSignal,
		runSubworkflow,
		bashAsk,
		log,
		phase,
		writeArtifact,
		appendArtifact,
	} = deps;
	const namespacedAgent = (prompt: string, options: InternalAgentOptions = {}) =>
		agent(prompt, {
			...options,
			...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}),
		});
	return {
		cwd: ctx.cwd,
		runId,
		runDir,
		input: apiInput,
		limits: runLimits,
		log,
		phase,
		agent: namespacedAgent,
		agents: makeRunAgents(
			{
				getConcurrencyCap: () => runLimits.concurrency,
				nextPhaseId: bumpAgentPhaseCount,
				getFanoutSignal,
			},
			namespacedAgent,
		),
		workflow: allowWorkflow
			? runSubworkflow
			: async () => {
					throw new Error(
						"workflow() composition depth limit is 1: sub-workflows cannot call other sub-workflows.",
					);
				},
		ask: async (question, options = {}) =>
			await runAsk(bashAsk, question, {
				...options,
				...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}),
			}),
		bash: async (command, options = {}) =>
			await runBash(bashAsk, command, {
				...options,
				...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}),
			}),
		readFile: async (filePath, encoding = "utf8") => await fs.readFile(resolveCwdPath(ctx.cwd, filePath), encoding),
		writeFile: async (filePath, data) => {
			const file = resolveCwdPath(ctx.cwd, filePath);
			await ensureDir(path.dirname(file));
			await fs.writeFile(file, data);
			return { path: file };
		},
		appendFile: async (filePath, data) => {
			const file = resolveCwdPath(ctx.cwd, filePath);
			await ensureDir(path.dirname(file));
			await fs.appendFile(file, data);
			return { path: file };
		},
		listFiles: async (dir = ".", options = {}) => {
			const root = resolveCwdPath(ctx.cwd, dir);
			const maxFiles = options.maxFiles ?? 10_000;
			const files: string[] = [];
			async function walk(current: string): Promise<void> {
				if (files.length >= maxFiles) return;
				for (const entry of await fs.readdir(current, { withFileTypes: true })) {
					if (entry.name === "node_modules" || entry.name === ".git") continue;
					const full = path.join(current, entry.name);
					if (entry.isDirectory()) await walk(full);
					else if (entry.isFile()) files.push(path.relative(ctx.cwd, full).replaceAll(path.sep, "/"));
					if (files.length >= maxFiles) return;
				}
			}
			await walk(root);
			return files;
		},
		writeArtifact,
		appendArtifact,
		sleep: async (ms) => await sleep(ms, runSignal.signal),
		json: (value, maxChars = MAX_TOOL_TEXT) => stringify(value, maxChars),
		compact: (value, maxChars = MAX_TOOL_TEXT) => stringify(value, maxChars),
	};
}
