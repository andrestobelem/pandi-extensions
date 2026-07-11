import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeCodeHash } from "../lib/code-hash.js";
import { AsyncMutex, abortReasonMessage, combineSignal, createSemaphore } from "../lib/concurrency.js";
import { safeJson } from "../lib/format.js";
import { OccurrenceCounter } from "../lib/occurrence-counter.js";
import { ensureDir } from "../lib/paths.js";
import type { AgentFocusMetrics } from "../observe/index.js";
import type {
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowResultIntegrity,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
} from "../types.js";
import type { BashAskContext } from "./bash-ask.js";
import type { RuntimeWorkflowDeps } from "./deps.js";
import { finalizeWorkflowRun } from "./finalize.js";
import { createWorkflowRunHost } from "./host.js";
import { makeApi } from "./make-api.js";
import { prepareWorkflowRun } from "./prepare.js";
import { writeWorkflowRunSnapshots } from "./snapshots.js";
import { type InternalAgentOptions, type RunSubagentContext, runSubagent as runSubagentImpl } from "./subagent.js";
import { runSubworkflow as runSubworkflowImpl } from "./subworkflow.js";
import { callSignal, executeWorkflowCode } from "./worker-bridge.js";

let tierEnvWarned = false;

export async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflowDefinition: WorkflowDefinition,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	deps: RuntimeWorkflowDeps,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	const { resolveWorkflow, preflightWorkflowLaunch } = deps;
	if (!prepared) await preflightWorkflowLaunch(ctx, workflowDefinition, input);
	const preparedRun = prepared ?? (await prepareWorkflowRun(ctx, workflowDefinition.name, false));
	const { started, runId, runDir } = preparedRun;
	const runLimits: Readonly<RunLimits> = Object.freeze({ ...limits });
	const agentsDir = path.join(runDir, "agents");
	await ensureDir(agentsDir);

	const runSignal = combineSignal(signal, runLimits.timeoutMs);
	const agentSemaphore = createSemaphore(runLimits.concurrency, runSignal.signal);
	const trackedSubagents = new Set<Promise<unknown>>();
	const logs: WorkflowLogEntry[] = [];
	// Ejecuciones reanudadas comienzan agentCount más allá de los artifacts agents/NNNN ya en disco
	// para que los subagentes recién re-ejecutados nunca sobrescriban los en caché. Ese ID histórico
	// no es un presupuesto: maxAgents limita solo los lanzamientos frescos de esta ejecución.
	let agentCount = preparedRun.resume?.baseAgentCount ?? 0;
	let launchedAgents = 0;
	let agentPhaseCount = 0;
	let explicitPhaseCount = 0;
	let parallelAgents = 0;
	let peakParallelAgents = preparedRun.resume?.previousPeakParallelAgents ?? 0;
	let state: WorkflowRunState = "running";

	// Content-address cache (for resumable/idempotent runs).
	let codeHash = preparedRun.resume?.codeHash ?? "";
	const resumedFrom = preparedRun.resume?.resumedFrom;
	const journal = preparedRun.resume?.journal;
	const occurrences = new OccurrenceCounter();
	// Serializes the occ-assignment prologue (persona/access resolution + key + occ assignment).
	// runExclusive chains its queue synchronously at call time, so wrapping the prologue
	// in it pins occ assignment to synchronous emission order — independent of how the
	// persona/access fs awaits interleave under ctx.agents/parallel/pipeline concurrency.
	// This is what makes occ (and therefore resume-cache lookups) deterministic.
	const occAssignMutex = new AsyncMutex();
	let cachedCalls = 0;
	// Focus observability (research §4): per-agent metrics folded from each freshly-run
	// subagent's JSON-mode stdout, aggregated into metrics.json/metrics.md at run end.
	// Cached/resumed calls (served from the journal) are not re-run, so they are excluded.
	const focusByAgent: AgentFocusMetrics[] = [];
	const integrity: WorkflowResultIntegrity = {
		agentResults: 0,
		failedAgents: 0,
		emptyOutputAgents: 0,
		outputTruncatedAgents: 0,
		stdoutTruncatedAgents: 0,
		timedOutAgents: 0,
		schemaFailedAgents: 0,
	};

	const host = createWorkflowRunHost({
		runDir,
		runId,
		workflowDefinition,
		preparedRun,
		started,
		runLimits,
		resumedFrom,
		onProgress,
		signal: runSignal.signal,
		getState: () => state,
		getAgentCount: () => agentCount,
		getParallelAgents: () => parallelAgents,
		getPeakParallelAgents: () => peakParallelAgents,
		getLogs: () => logs,
		getCodeHash: () => codeHash,
		getCachedCalls: () => cachedCalls,
		getIntegrity: () => integrity,
		bumpExplicitPhaseCount: () => ++explicitPhaseCount,
		trackedSubagents,
	});
	const {
		log,
		phase,
		writeArtifact,
		appendArtifact,
		appendEvent,
		trackSubagent,
		recordAgentIntegrity,
		resultIntegrity,
		persistStatus,
		publishStatus,
		makeStatus,
	} = host;

	const subagentHost: RunSubagentContext = {
		pi,
		ctx,
		runDir,
		runLimits,
		runSignal,
		journal,
		occurrences,
		occAssignMutex,
		agentSemaphore,
		getAgentCount: () => agentCount,
		bumpAgentCount: () => ++agentCount,
		getLaunchedAgents: () => launchedAgents,
		bumpLaunchedAgents: () => {
			launchedAgents++;
		},
		bumpCachedCalls: () => {
			cachedCalls++;
		},
		pushFocus: (focus) => {
			focusByAgent.push(focus);
		},
		bumpParallelAgents: () => {
			parallelAgents++;
			peakParallelAgents = Math.max(peakParallelAgents, parallelAgents);
		},
		releaseParallelAgents: () => {
			parallelAgents = Math.max(0, parallelAgents - 1);
		},
		getCodeHash: () => codeHash,
		log,
		appendEvent,
		writeArtifact,
		publishStatus,
		recordAgentIntegrity,
		getTierEnvWarned: () => tierEnvWarned,
		setTierEnvWarned: (v) => {
			tierEnvWarned = v;
		},
	};
	const runSubagent = (prompt: string, options: InternalAgentOptions = {}) =>
		runSubagentImpl(subagentHost, prompt, options);

	const agent = (prompt: string, options: InternalAgentOptions = {}) => trackSubagent(runSubagent(prompt, options));

	const bashAsk: BashAskContext = {
		pi,
		ctx,
		runDir,
		getCodeHash: () => codeHash,
		journal,
		occurrences,
		runLimits,
		runSignal,
		bumpCachedCalls: () => {
			cachedCalls++;
		},
		log,
		appendEvent,
	};

	function makeApiLocal(workflowNamespace: string | undefined, allowWorkflow: boolean, apiInput: unknown) {
		return makeApi(
			{
				ctx,
				runId,
				runDir,
				runLimits,
				runSignal,
				agent,
				getAgentPhaseCount: () => agentPhaseCount,
				bumpAgentPhaseCount: () => ++agentPhaseCount,
				getFanoutSignal: () => callSignal.getStore() ?? runSignal.signal,
				runSubworkflow: runSubworkflowLocal,
				bashAsk,
				log,
				phase,
				writeArtifact,
				appendArtifact,
			},
			workflowNamespace,
			allowWorkflow,
			apiInput,
		);
	}

	async function runSubworkflowLocal(name: string, workflowInput: unknown = {}): Promise<unknown> {
		return runSubworkflowImpl(
			{
				ctx,
				resolveWorkflow,
				parentWorkflowDefinition: workflowDefinition,
				runSignal,
				runLimits,
				occurrences,
				getAgentCount: () => agentCount,
				appendEvent,
				log,
				makeApi: makeApiLocal,
			},
			name,
			workflowInput,
		);
	}

	const api = makeApiLocal(undefined, true, input);

	let output: unknown;
	let error: string | undefined;
	try {
		await fs.writeFile(path.join(runDir, "input.json"), `${safeJson(input)}\n`, "utf8");
		// Read the code up front so codeHash is available before the first status
		// is written (resumes pass it in; fresh runs derive it here).
		const code = await fs.readFile(workflowDefinition.path, "utf8");
		if (!codeHash) codeHash = computeCodeHash(code);
		await writeWorkflowRunSnapshots(ctx, workflowDefinition, code, runDir, { resolveWorkflow });
		await persistStatus();
		await log(`workflow start: ${workflowDefinition.name}`, {
			file: workflowDefinition.path,
			runDir,
			...(resumedFrom ? { resumedFrom } : {}),
		});
		output = await executeWorkflowCode(workflowDefinition, code, api, input, runLimits, runSignal.signal);
		state = "completed";
		await log(`workflow end: ${workflowDefinition.name}`);
	} catch (err) {
		error = err instanceof Error ? err.stack || err.message : String(err);
		const reason = runSignal.signal.aborted ? abortReasonMessage(runSignal.signal) : "";
		state = reason.toLowerCase().includes("cancel") ? "cancelled" : "failed";
		await log(`workflow ${state}: ${workflowDefinition.name}`, { error });
	} finally {
		runSignal.abort();
		await Promise.allSettled([...trackedSubagents]);
		agentSemaphore.dispose();
		runSignal.dispose();
	}

	const result = await finalizeWorkflowRun(
		{ resultIntegrity, makeStatus },
		{
			workflowDefinition,
			runId,
			runDir,
			background: preparedRun.background,
			started,
			runLimits,
			agentCount,
			parallelAgents,
			peakParallelAgents,
			logs,
			state,
			output,
			error,
			codeHash,
			cachedCalls,
			resumedFrom,
			focusByAgent,
		},
	);
	return result;
}
