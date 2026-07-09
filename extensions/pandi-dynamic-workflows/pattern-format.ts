/**
 * Helpers de presentación que renderizan el catálogo de patrones de workflow en los
 * strings de prompt/cheat-sheet mostrados a humanos y al modelo. Separados de
 * pattern-scaffolds.ts por cohesión; formatters puros sobre datos de catalog.ts.
 */

import type { WorkflowPattern } from "./catalog.js";
import { getPatternUseCases, WORKFLOW_PATTERN_CATALOG } from "./catalog.js";

export function formatWorkflowPatternCatalog(patterns = WORKFLOW_PATTERN_CATALOG): string {
	const lines = [
		"Catálogo de patrones de workflow",
		"Uso en TUI: /workflows → tab Patterns; Enter/n crea un draft de workflow del proyecto.",
		"Uso desde comando: /workflow new <name> --pattern=<key>",
		"Uso desde tool: dynamic_workflow action=scaffold name=<key>",
		"",
	];
	const sections: [WorkflowPattern["category"], string][] = [
		["scaffold", "Scaffolds"],
		["compose", "Scaffolds de composición"],
		["use-case", "Scaffolds por caso de uso"],
	];
	for (const [category, label] of sections) {
		const sectionPatterns = patterns.filter((pattern) => (pattern.category ?? "scaffold") === category);
		if (sectionPatterns.length === 0) continue;
		lines.push(`## ${label}`, "");
		for (const pattern of sectionPatterns) {
			const useCases = getPatternUseCases(pattern);
			lines.push(`- ${pattern.key} — ${pattern.title}`);
			lines.push(`  ${pattern.blurb}`);
			lines.push(`  Cuándo: ${pattern.useWhen}`);
			if (useCases.length) lines.push(`  Casos de uso: ${useCases.slice(0, 3).join("; ")}`);
			lines.push(`  Input: ${pattern.inputHint}`);
			lines.push(`  Primitivas: ${pattern.primitives.join(", ")}`);
		}
		lines.push("");
	}
	lines.push(
		"## Plantillas apoyadas en research",
		"",
		"Mapeo de papers/frameworks comunes de agentes al diseño de workflows en Pi:",
		"",
		"- **ReAct** -> scoutear/observar con tools antes del fan-out; mantener el razonamiento atado a la evidencia.",
		"- **Self-consistency** -> muestrear ramas independientes y luego elegir por consistencia/evidencia, en vez de confiar en un solo camino.",
		"- **Reflexion / Self-Refine** -> loops de generate -> critique -> refine, siempre acotados por rondas, quiet stops, `maxAgents` y timeout.",
		"- **Tree of Thoughts** -> ramificar alternativas, evaluar/podar con un juez y luego comprometerse con un camino.",
		"- **Multiagent debate** -> reviewers adversariales más síntesis-como-juez; los claims sin soporte se descartan.",
		"- **AutoGen / CAMEL / MetaGPT** -> roles explícitos, artifacts estables y contratos de handoff claros.",
		"- **SWE-agent / DSPy** -> importan la interfaz y los contratos: tools estrechos, schemas/formatos fijos y chequeos reproducibles.",
		"",
		"Usalos como patterns, no como ceremonia: cada rama necesita una razón, un contrato y una condición de parada.",
	);
	return lines.join("\n").trimEnd();
}

export function formatWorkflowPatternPromptCheatSheet(patterns = WORKFLOW_PATTERN_CATALOG): string {
	const lines = [
		"Catálogo de scaffolds de workflow (elegí uno antes de escribir desde cero; inspeccioná con dynamic_workflow action=scaffold y traé un scaffold con name=<key>):",
	];
	for (const pattern of patterns) {
		lines.push(`- ${pattern.key}: ${pattern.useWhen} Primitives: ${pattern.primitives.join(", ")}.`);
	}
	return lines.join("\n");
}

export function formatWorkflowCompositionPromptGuidance(): string {
	return [
		"Reglas de composición de workflows:",
		'- Usá workflow("lib/<name>", args) para un sub-step reusable sin gate de decisión humano/agente entre padre e hijo; conserva una corrida compartida, pool de concurrency, budget maxAgents, abort signal, runDir y journal de resume/cache.',
		"- Guardá contratos reutilizables bajo lib/<name>.js, aceptá un único objeto args, validá inputs, devolvé resultados JSON-serializables estables y documentá el contrato en el comentario de cabecera.",
		"- Depth es 1: un sub-workflow no debe volver a llamar workflow(); si la fase siguiente depende de inspeccionar output del hijo, corré workflows separados en secuencia e inspeccioná artifacts entre corridas.",
		'- Preferí compose-verify-claims más lib-verify-claims como patrón de referencia para discovery -> verificación reusable; graficá llamadas literales workflow("...") al revisar estructura.',
	].join("\n");
}

export function formatWorkflowPatternKeyList(patterns = WORKFLOW_PATTERN_CATALOG): string {
	const keys = patterns.map((pattern) => pattern.key).join(", ");
	return `Scaffolds de workflow: ${keys}. Inspeccioná detalles con dynamic_workflow action=scaffold; traé un scaffold con name=<key>.`;
}

export function formatWorkflowCompositionPromptSummary(): string {
	return 'Composición: usá workflow("lib/<name>", args) solo para sub-steps reutilizables sin gate de decisión; depth es 1; inspeccioná el output hijo en una corrida separada antes de cambiar de rumbo.';
}
