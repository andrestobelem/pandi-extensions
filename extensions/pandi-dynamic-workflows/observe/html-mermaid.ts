import type { RunReportAgent, RunReportModel } from "./html.js";

/** Sanitiza etiquetas Mermaid (copia local; observe no importa tui/graph). */
function mermaidLabel(value: string): string {
	return (
		value
			.replace(/["<>{}[\]()|]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 90) || "step"
	);
}

export const MERMAID_CDN_VERSION = "11.15.0";
export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_VERSION}/dist/mermaid.min.js`;
// Hash SHA-384 calculado en local contra el mermaid.min.js publicado en npm para esta
// versión exacta (node_modules/mermaid/dist/mermaid.min.js) — no se confió en la CDN a
// ciegas. Si el archivo servido por la CDN alguna vez no matchea, el navegador se niega a
// ejecutarlo (Subresource Integrity): falla cerrado, nunca ejecuta contenido inesperado.
export const MERMAID_CDN_INTEGRITY = "sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF";

function mermaidStateClass(agent: RunReportAgent): "completed" | "failed" | "running" | "other" {
	if (agent.ok === false || agent.state === "failed") return "failed";
	if (agent.state === "completed" || agent.ok === true) return "completed";
	if (agent.state === "running") return "running";
	return "other";
}

// Tonos pastel (no los sólidos/saturados típicos de mermaid): el diagrama vive al lado de
// la estética más suave del resto del reporte (pills de estado con fondo tenue + borde),
// y un bloque sólido bien saturado se siente más fuerte que el resto de la página.
const MERMAID_STATE_STYLES: Record<string, string> = {
	completed: "fill:#8fd6ab,color:#0b2e1d,stroke:#3fa066",
	failed: "fill:#f2a9a3,color:#3a0e0b,stroke:#d1554a",
	running: "fill:#9dc6f2,color:#0b2440,stroke:#4f86c9",
	other: "fill:#c7ccd1,color:#1c1f22,stroke:#8b939b",
};

const MAX_DETAILED_MERMAID_AGENTS_PER_GROUP = 12;

/**
 * Flowchart Mermaid del run concreto: agentes agrupados por fase en orden de aparición,
 * coloreados por estado. Complementa — no reemplaza — el grafo estático de workflow-graph.ts
 * (que dibuja la ESTRUCTURA del código, no una corrida). La fuente se escapa como texto antes
 * de llegar al contenedor `.mermaid` y también queda disponible como fallback colapsable; el
 * render client-side está pineado por observe/security.test.mjs (CDN exacta + SRI + sandbox).
 */
interface RunMermaidGroup {
	label: string;
	agents: RunReportAgent[];
}

interface RunMermaidWave {
	agents: RunReportAgent[];
}

function timestampMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function inferPhaseForAgent(
	agent: RunReportAgent,
	phases: RunReportModel["phases"],
): { key: string; label: string } | undefined {
	if (agent.phaseId !== undefined || agent.phaseLabel) {
		const key = agent.phaseId !== undefined ? `p${agent.phaseId}` : `label:${agent.phaseLabel}`;
		return { key, label: agent.phaseLabel ?? `Phase ${agent.phaseId}` };
	}
	const ref = timestampMs(agent.startedAt) ?? timestampMs(agent.endedAt);
	if (ref === undefined) return undefined;
	let chosen: RunReportModel["phases"][number] | undefined;
	let chosenMs = Number.NEGATIVE_INFINITY;
	for (const phase of phases) {
		const phaseMs = timestampMs(phase.time);
		if (phaseMs === undefined || phaseMs > ref || phaseMs < chosenMs) continue;
		chosen = phase;
		chosenMs = phaseMs;
	}
	if (!chosen) return undefined;
	const key = chosen.source === "event" ? `p${modelPhaseKey(chosen)}` : `label:${chosen.label}`;
	return { key, label: chosen.label };
}

function modelPhaseKey(phase: RunReportModel["phases"][number]): string {
	return `${phase.time}:${phase.label}`;
}

function buildRunMermaidGroups(model: RunReportModel): RunMermaidGroup[] {
	const groups = new Map<string, RunMermaidGroup>();
	for (const agent of model.agents) {
		const phase = inferPhaseForAgent(agent, model.phases) ?? { key: "none", label: "Agents" };
		const group = groups.get(phase.key);
		if (group) group.agents.push(agent);
		else groups.set(phase.key, { label: phase.label, agents: [agent] });
	}
	return [...groups.values()];
}

/**
 * Un nombre de fase no expresa dependencias: `parallel()` y una síntesis posterior
 * pueden compartirlo. Cuando los intervalos completos lo prueban, separamos las
 * oleadas; sin timestamps completos conservamos el agrupamiento actual y no
 * inventamos serialidad.
 */
function buildRunMermaidWaves(agents: RunReportAgent[]): RunMermaidWave[] {
	if (agents.length <= 1) return [{ agents }];
	const timed = agents.map((agent) => ({
		agent,
		started: timestampMs(agent.startedAt),
		ended: timestampMs(agent.endedAt),
	}));
	if (timed.some(({ started, ended }) => started === undefined || ended === undefined || ended < started))
		return [{ agents }];

	timed.sort((a, b) => a.started! - b.started! || a.ended! - b.ended! || a.agent.id - b.agent.id);
	const waves: RunMermaidWave[] = [];
	let wave: RunReportAgent[] = [];
	let waveEndsAt = Number.NEGATIVE_INFINITY;
	for (const { agent, started, ended } of timed) {
		// Un relevo exacto sigue siendo secuencial: el runtime cuenta ends antes que starts
		// cuando estima el pico de paralelismo.
		if (wave.length > 0 && started! >= waveEndsAt) {
			waves.push({ agents: wave });
			wave = [];
			waveEndsAt = Number.NEGATIVE_INFINITY;
		}
		wave.push(agent);
		waveEndsAt = Math.max(waveEndsAt, ended!);
	}
	waves.push({ agents: wave });
	return waves;
}

function agentStateCounts(agents: RunReportAgent[]): Record<"completed" | "failed" | "running" | "other", number> {
	return agents.reduce(
		(counts, agent) => {
			counts[mermaidStateClass(agent)] += 1;
			return counts;
		},
		{ completed: 0, failed: 0, running: 0, other: 0 },
	);
}

function summaryStateClass(
	counts: Record<"completed" | "failed" | "running" | "other", number>,
): "completed" | "failed" | "running" | "other" {
	if (counts.failed > 0) return "failed";
	if (counts.running > 0) return "running";
	if (counts.completed > 0 && counts.other === 0) return "completed";
	return "other";
}

function mermaidGroupSummaryLabel(agents: RunReportAgent[]): string {
	const counts = agentStateCounts(agents);
	return [
		`${agents.length} agents`,
		counts.completed ? `${counts.completed} completed` : "",
		counts.failed ? `${counts.failed} failed` : "",
		counts.running ? `${counts.running} running` : "",
		counts.other ? `${counts.other} other` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export function buildRunMermaidSource(model: RunReportModel): string {
	if (model.agents.length === 0) {
		return 'flowchart TD\n  none["No agents in this run"]';
	}

	const groups = buildRunMermaidGroups(model);
	const lines = ["flowchart TD", '  start(["start"])'];
	const phaseEntries: string[] = [];
	const phaseExits: string[] = [];
	const usedClasses = new Set<string>();
	const classLines: string[] = [];
	let index = 0;
	for (const group of groups) {
		index += 1;
		const phaseId = `phase${index}`;
		const waves = buildRunMermaidWaves(group.agents);
		let previousExit: string | undefined;
		lines.push(`  subgraph ${phaseId}["${mermaidLabel(group.label)}"]`);
		lines.push("    direction TD");
		for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
			const wave = waves[waveIndex];
			const suffix = waves.length > 1 ? `_wave${waveIndex + 1}` : "";
			const entryId = `${phaseId}${suffix}_in`;
			const exitId = `${phaseId}${suffix}_out`;
			const parallel = wave.agents.length > 1;
			if (previousExit) lines.push(`    ${previousExit} --> ${entryId}`);
			lines.push(`    ${entryId}(("${parallel ? "fork" : "start"}"))`);
			lines.push(`    ${exitId}(("${parallel ? "join" : "done"}"))`);
			if (wave.agents.length > MAX_DETAILED_MERMAID_AGENTS_PER_GROUP) {
				const counts = agentStateCounts(wave.agents);
				const cls = summaryStateClass(counts);
				const summaryId = `${phaseId}${suffix}_summary`;
				lines.push(`    ${summaryId}(["${mermaidLabel(mermaidGroupSummaryLabel(wave.agents))}"])`);
				lines.push(`    ${entryId} --> ${summaryId}`);
				lines.push(`    ${summaryId} --> ${exitId}`);
				usedClasses.add(cls);
				classLines.push(`  class ${summaryId} ${cls}`);
			} else {
				for (const agent of wave.agents) {
					const cls = mermaidStateClass(agent);
					// Forma "stadium" (bordes totalmente redondeados): combina con el estilo pill de
					// los <span class="rpill"> de estado que usa el resto del reporte.
					lines.push(`    A${agent.id}(["${mermaidLabel(agent.name)}"])`);
					lines.push(`    ${entryId} --> A${agent.id}`);
					lines.push(`    A${agent.id} --> ${exitId}`);
					usedClasses.add(cls);
					classLines.push(`  class A${agent.id} ${cls}`);
				}
			}
			if (waveIndex === 0) phaseEntries.push(entryId);
			previousExit = exitId;
		}
		if (previousExit) phaseExits.push(previousExit);
		lines.push("  end");
	}
	if (phaseEntries.length > 0) {
		lines.push(`  start --> ${phaseEntries[0]}`);
		for (let i = 0; i < phaseEntries.length - 1; i += 1) {
			lines.push(`  ${phaseExits[i]} --> ${phaseEntries[i + 1]}`);
		}
		lines.push(`  ${phaseExits[phaseExits.length - 1]} --> done(["done"])`);
	}

	for (const cls of usedClasses) {
		lines.push(`  classDef ${cls} ${MERMAID_STATE_STYLES[cls]}`);
	}
	lines.push(...classLines);

	return lines.join("\n");
}
