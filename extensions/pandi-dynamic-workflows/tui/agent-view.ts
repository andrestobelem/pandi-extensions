/**
 * Agent view orchestration — live/finished agent detail UI (showLiveAgentView), workflow
 * definition/graph tab formatters, and live polling via AgentLiveViewComponent.
 *
 * Markdown formatting helpers live in agent-view-format.ts. Deferred cycles: showLiveAgentView
 * constructs AgentLiveViewComponent (agent-live-view.js) while that component reads
 * liveAgentHeaderStatus from here; event-parser.js reads extractMarkdownSection from here
 * inside a body. index.ts re-exports liveAgentHeaderStatus for the usability test.
 */
import * as fs from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncate } from "../lib/format.js";
import { notify } from "../lib/notify.js";
import { readRunEvents } from "../observe/event-parser.js";
import { computeCodeHash } from "../runtime/index.js";
import type { AgentMonitorModel, WorkflowRunRecord } from "../types.js";
import { AgentLiveViewComponent } from "./agent-live-view.js";
import {
	type AgentViewParts,
	buildAgentViewParts,
	extractMarkdownSection,
	fencedBlock,
	formatAgentView,
	resolveAgentArtifactPath,
} from "./agent-view-format.js";
import { formatRunView, pickAndOpenRunArtifact } from "./run-view.js";

export type { AgentViewParts };
export { buildAgentViewParts, extractMarkdownSection, resolveAgentArtifactPath };

const TERMINAL_AGENT_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cached"]);

function isTerminalAgentState(state: string | undefined): boolean {
	return state !== undefined && TERMINAL_AGENT_STATES.has(state);
}

// Header status label for the live agent viewer: keep advertising the 1s poll
// only while the agent can still change; show a stable "final" marker once it
// reaches a terminal state (and the poll is stopped).
export function liveAgentHeaderStatus(state: string | undefined): string {
	return isTerminalAgentState(state) ? `final (${state})` : "refresh 1s";
}

// La pestaña Definition: la fuente del flujo de trabajo que ejecutó esta ejecución, como un bloque de código cercado,
// con una advertencia de caché de reanudación cuando el archivo cambió desde la ejecución (igual verificación de hash que
// hace la vista de ejecución).
async function formatWorkflowDefinition(run: WorkflowRunRecord): Promise<string> {
	const header = [`# Workflow definition: ${run.workflow}`, "", `File: ${run.file ?? "unknown"}`];
	if (!run.file) return [...header, "", "No workflow file was recorded for this run."].join("\n");
	let code: string;
	try {
		code = await fs.readFile(run.file, "utf8");
	} catch (err) {
		return [...header, "", `Cannot read workflow file: ${err instanceof Error ? err.message : String(err)}`].join(
			"\n",
		);
	}
	const codeChanged = run.codeHash !== undefined && computeCodeHash(code) !== run.codeHash;
	return [
		...header,
		...(codeChanged
			? [
					"",
					"⚠ Warning: this file changed since the run started. On resume, calls whose arguments changed will re-execute (cache miss); unchanged calls stay cached.",
				]
			: []),
		"",
		fencedBlock(truncate(code, 60_000), "js"),
	].join("\n");
}

// La pestaña Graph: una representación Markdown/texto del mismo gráfico de flujo de trabajo estático
// usado por /workflow graph. Mantenlo como text+Mermaid dentro del visor Markdown con pestañas;
// la acción de gráfico independiente posee el componente más rico capaz de PNG.
async function formatWorkflowGraphView(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<string> {
	const header = [`# Workflow graph: ${run.workflow}`, "", `Run: ${run.runId}`];
	const { resolveWorkflowForRun } = await import("../surface/index.js");
	const workflow = await resolveWorkflowForRun(ctx, run);
	if (!workflow) return [...header, "", "Cannot open graph: workflow file not found."].join("\n");
	let code: string;
	try {
		code = await fs.readFile(workflow.path, "utf8");
	} catch (err) {
		return [...header, "", `Cannot read workflow file: ${err instanceof Error ? err.message : String(err)}`].join(
			"\n",
		);
	}
	const codeChanged = run.codeHash !== undefined && computeCodeHash(code) !== run.codeHash;
	const { makeWorkflowGraphForContext } = await import("./graph/index.js");
	return [
		...header,
		`File: ${workflow.path}`,
		...(codeChanged
			? ["", "⚠ Warning: this file changed since the run started, so the graph reflects the current workflow file."]
			: []),
		"",
		await makeWorkflowGraphForContext(ctx, workflow, code),
	].join("\n");
}

async function latestAgentForRun(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<AgentMonitorModel> {
	const { agents } = await readRunEvents(run.runDir);
	return agents.find((candidate) => candidate.id === agent.id) ?? agent;
}

export async function showLiveAgentView(
	ctx: ExtensionContext,
	run: WorkflowRunRecord,
	agent: AgentMonitorModel,
): Promise<void> {
	if (ctx.mode === "print") {
		console.log(await formatAgentView(run, await latestAgentForRun(run, agent)));
		return;
	}
	if (ctx.mode === "tui") {
		// bucle open→action→reopen: `f` deja al usuario abrir uno de los artefactos de la ejecución en
		// el visor correcto (.md → Markdown, de lo contrario texto), luego regresa a la vista de agente en vivo —
		// la misma capacidad que tiene la vista de ejecución, para que la pantalla del agente "encaje" con ella.
		// La pantalla de detalle es un visor SUB-TABULADO (Card / Prompt / Graph / Output / Definition / Run)
		// para que el usuario pueda moverse entre la tarjeta del agente, su prompt, el gráfico del flujo de trabajo, su salida,
		// la fuente del flujo de trabajo, y la vista de ejecución completa sin rebotar al panel.
		let definitionCache: string | undefined; // estático por ejecución: carga una vez, reutiliza entre pestañas/actualizaciones
		let graphCache: string | undefined; // estático por ejecución: carga una vez, reutiliza entre pestañas/actualizaciones
		for (;;) {
			let timer: NodeJS.Timeout | undefined;
			let refreshing = false;
			let component: AgentLiveViewComponent | undefined;
			let intent: "openFiles" | undefined;
			try {
				intent = await ctx.ui.custom<"openFiles" | undefined>((tui, theme, _keybindings, done) => {
					let pending = false;
					const refresh = async () => {
						if (!component) return;
						if (refreshing) {
							// Un cambio de pestaña durante una actualización en vuelo no debe ser descartado: el
							// nuevo tab estaría en "Cargando…" por siempre una vez que la encuesta de estado terminal se detiene.
							pending = true;
							return;
						}
						refreshing = true;
						try {
							const latest = await latestAgentForRun(run, agent);
							component.setState(latest.state);
							const active = component.getActiveTab();
							if (active === "card" || active === "prompt" || active === "output") {
								// Una lectura de artefacto produce las tres secciones del agente; rellénalas juntas.
								const parts = await buildAgentViewParts(run, latest);
								component.setTabContent("card", parts.card);
								component.setTabContent("prompt", parts.prompt);
								component.setTabContent("output", parts.output);
							} else if (active === "definition") {
								definitionCache ??= await formatWorkflowDefinition(run);
								component.setTabContent("definition", definitionCache);
							} else if (active === "run") {
								component.setTabContent("run", await formatRunView(run));
							} else if (active === "graph") {
								graphCache ??= await formatWorkflowGraphView(ctx, run);
								component.setTabContent("graph", graphCache);
							}
							tui.requestRender();
							// Detén el sondeo una vez que el agente es terminal; la salida final permanece
							// en pantalla hasta que el usuario cierre la vista. Los cambios de pestaña aún se actualizan
							// bajo demanda a través de onTabChange abajo.
							if (timer && isTerminalAgentState(latest.state)) {
								clearInterval(timer);
								timer = undefined;
							}
						} finally {
							refreshing = false;
							if (pending) {
								pending = false;
								void refresh();
							}
						}
					};
					component = new AgentLiveViewComponent(
						theme,
						() => tui.terminal.rows,
						done,
						() => tui.requestRender(),
						true,
						[
							{ key: "card", label: "Card" },
							{ key: "prompt", label: "Prompt" },
							{ key: "graph", label: "Graph" },
							{ key: "output", label: "Output" },
							{ key: "definition", label: "Definition" },
							{ key: "run", label: "Run" },
						],
						() => void refresh(), // load the newly-focused tab immediately
					);
					timer = setInterval(() => void refresh(), 1000);
					void refresh();
					return component;
				});
			} finally {
				if (timer) clearInterval(timer);
			}
			if (intent !== "openFiles") return;
			await pickAndOpenRunArtifact(ctx, run);
		}
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(
			`Workflow agent: ${agent.name}`,
			await formatAgentView(run, await latestAgentForRun(run, agent)),
		);
		return;
	}
	notify(ctx, await formatAgentView(run, await latestAgentForRun(run, agent)), "info");
}
