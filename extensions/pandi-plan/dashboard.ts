/**
 * Dashboard de seguimiento de modo plan — kernel de renderizado PURO.
 *
 * `buildPlanDashboardMarkdown` convierte un conjunto de snapshots de planes (el historial de planes
 * de la sesión + el plan activo) en un reporte Markdown para `/plan dashboard`. Es
 * puro y DETERMINISTA (sin Date.now / sin I/O): todo lo que muestra se deriva
 * de sus inputs, así que es trivialmente unit-testable. El cableado del comando y el
 * overlay de scroll TUI viven en index.ts (el overlay necesita un TUI vivo que no podemos
 * ejercitar desde el harness de integración empaquetado).
 *
 * Para el plan activo también renderiza un CHECKLIST de estilo Claude parseado del
 * texto del plan sumado más recientemente por `extractPlanChecklist` (también puro): el estado
 * de la task-list GFM se preserva, en otro caso los pasos se derivan de las listas/headings del plan.
 *
 * Depende del concepto leaf `PlanState` vía `state.ts`, no del runtime `index.ts`.
 * El alias `PlanSnapshot` mantiene el nombre de la vista sin duplicar la forma del estado.
 * Sibling de profundidad uno importado vía "./dashboard.js".
 *
 * `renderPlanDashboardOverlay` hospeda el overlay de scroll TUI (un mínimo
 * componente autocontenido — sin importación de runtime pi-tui) así que index.ts solo mantiene el
 * cableado del comando + colección de planes; cualquier fallo del overlay se degrada a una notificación.
 */

import type { PlanState } from "./state.js";

/** Snapshot de plan que este dashboard renderiza: el mismo concepto persistido por el runtime. */
export type PlanSnapshot = PlanState;

/** Tags de postura legibles (o "interactiva" cuando no se setea ninguna bandera). */
export function planPosture(plan: PlanSnapshot): string {
	const tags: string[] = [];
	if (plan.nonInteractive) tags.push("plan-only");
	if (plan.ultracode) tags.push("ultracode");
	if (plan.ultracodeSteps) tags.push("ultracode-steps");
	if (plan.autoSubmit) tags.push("auto-submit");
	return tags.length ? tags.join(", ") : "interactiva";
}

/** Colapsa espacios en blanco y corta a una única línea de más de `max` caracteres. */
function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function renderDashboardMarkdown(lines: string[]): string {
	return lines.join("\n");
}

/** Un paso de checklist de estilo Claude parseado del Markdown de un plan. */
export interface ChecklistItem {
	text: string;
	checked: boolean;
}

const CHECKLIST_TEXT_MAX = 120;

/**
 * Parsea el Markdown de un plan sumado en un checklist de pasos de estilo Claude. PURO
 * y determinista (sin I/O, sin Date.now), así que es trivialmente unit-testable.
 *
 * Estrategia, en orden de prioridad (el PRIMER tipo que produce algún item gana, así que un plan
 * que ya usa task lists GFM mantiene su estado checked/unchecked):
 *   1. Items de task-list GFM: `- [ ]` / `- [x]` (también bullets `*`/`+` y prefijos `1.`/`1)` ordenados). `[x]`/`[X]` => chequeado.
 *   2. Items de lista ordenada (`1. paso`) => pasos sin checkear.
 *   3. Items de lista con bullets (`- paso`) => pasos sin checkear.
 *   4. Headings `##`..`######` => pasos sin checkear (cuando el plan no tiene listas).
 * Devuelve [] cuando no se encuentra nada estructurado.
 */
export function extractPlanChecklist(markdown: string): ChecklistItem[] {
	const uncheckedItem = (text: string): ChecklistItem => ({ text: clip(text, CHECKLIST_TEXT_MAX), checked: false });
	const taskItems: ChecklistItem[] = [];
	const ordered: ChecklistItem[] = [];
	const bullets: ChecklistItem[] = [];
	const headings: ChecklistItem[] = [];
	for (const raw of String(markdown).split("\n")) {
		const line = raw.trim();
		const task = line.match(/^(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)/);
		if (task) {
			taskItems.push({ text: clip(task[2], CHECKLIST_TEXT_MAX), checked: task[1].toLowerCase() === "x" });
			continue;
		}
		const ord = line.match(/^\d+[.)]\s+(.*\S)/);
		if (ord) {
			ordered.push(uncheckedItem(ord[1]));
			continue;
		}
		const bul = line.match(/^[-*+]\s+(.*\S)/);
		if (bul) {
			bullets.push(uncheckedItem(bul[1]));
			continue;
		}
		const head = line.match(/^#{2,6}\s+(.*\S)/);
		if (head) headings.push(uncheckedItem(head[1]));
	}
	if (taskItems.length) return taskItems;
	if (ordered.length) return ordered;
	if (bullets.length) return bullets;
	return headings;
}

/**
 * Renderiza el dashboard de modo plan como Markdown: un header con totales de sesión, una
 * sección de detalle "Activo" para cualquier plan armado (postura, conteos, último plan
 * sumado), y una tabla "Historial" de cada plan en la sesión (más antiguo primero).
 */
export function buildPlanDashboardMarkdown(plans: PlanSnapshot[]): string {
	const lines: string[] = ["# Dashboard de Modo Plan", ""];
	if (plans.length === 0) {
		lines.push(
			"Todavía no hay planes registrados en esta sesión. Empezá uno con `/plan <task>` o la tool `enter_plan_mode`.",
		);
		return renderDashboardMarkdown(lines);
	}

	const sorted = [...plans].sort((a, b) => a.startedAt - b.startedAt);
	const active = sorted.filter((p) => p.active);
	const totalSubs = sorted.reduce((n, p) => n + p.submissions, 0);
	const totalRej = sorted.reduce((n, p) => n + p.rejections, 0);
	lines.push(
		`**Planes:** ${sorted.length} · **activos:** ${active.length} · **enviados:** ${totalSubs} · **rechazados:** ${totalRej}`,
		"",
	);

	if (active.length) {
		lines.push("## Activo");
		for (const p of active) {
			lines.push(
				"",
				`### ${p.planId} — ${p.status} (gate de solo lectura ARMADO)`,
				`- **Postura:** ${planPosture(p)}`,
				`- **Envíos:** ${p.submissions} · **Rechazos:** ${p.rejections}`,
				`- **Actualizado:** ${p.updatedAt}`,
				`- **Tarea:** ${clip(p.task, 200)}`,
			);
			if (p.lastPlan) {
				// Checklist de estilo Claude derivado del plan sumido más recientemente.
				const steps = extractPlanChecklist(p.lastPlan);
				if (steps.length) {
					const done = steps.filter((s) => s.checked).length;
					lines.push("", `#### Checklist (${done}/${steps.length} listos)`);
					for (const s of steps) lines.push(`- [${s.checked ? "x" : " "}] ${s.text}`);
				} else {
					lines.push("", "_No se pudo extraer ningún paso del checklist del último plan._");
				}
				lines.push("", "<details><summary>Último plan enviado</summary>", "", p.lastPlan, "", "</details>");
			}
		}
		lines.push("");
	}

	lines.push(
		"## Historial",
		"",
		"| Plan | Estado | Postura | Envíos | Rech | Tarea |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const p of sorted) {
		const status = p.active ? `**${p.status}**` : p.status;
		lines.push(
			`| ${p.planId} | ${status} | ${planPosture(p)} | ${p.submissions} | ${p.rejections} | ${clip(p.task, 60)} |`,
		);
	}
	return renderDashboardMarkdown(lines);
}

export { renderPlanDashboardOverlay } from "./dashboard-view.js";
