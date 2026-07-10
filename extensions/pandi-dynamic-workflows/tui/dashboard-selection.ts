/**
 * Tabs, selection snapshot y helper de re-selección para WorkflowDashboard.
 * Puro: sin dependencias de TUI ni modelos de runtime.
 */

export const WORKFLOW_DASHBOARD_TABS = [
	"monitor",
	"agents",
	"sessions",
	"runs",
	"workflows",
	"patterns",
	"activity",
] as const;
export type WorkflowDashboardTab = (typeof WORKFLOW_DASHBOARD_TABS)[number];

export interface DashboardSelection {
	tab: WorkflowDashboardTab;
	workflowIndex: number;
	runIndex: number;
	activityIndex: number;
	sessionIndex: number;
	agentIndex: number;
	monitorAgentIndex: number;
	monitorRunIndex: number;
	patternIndex: number;
}

// Mantén el cursor en el mismo elemento cuando una lista se reconstruye/reordena debajo
// (las listas están ordenadas por mtime y se actualizan cada 1.5s, así que un índice fijo
// reorientaría silenciosamente acciones destructivas). Vuelve a la posición limitada cuando
// el elemento previamente seleccionado se ha ido.
export function reselectIndexByKey<T>(
	previous: T[],
	previousIndex: number,
	next: T[],
	keyOf: (item: T) => string,
): number {
	const clamped = Math.min(previousIndex, Math.max(0, next.length - 1));
	const prev = previous[previousIndex];
	if (!prev) return clamped;
	const key = keyOf(prev);
	const found = next.findIndex((item) => keyOf(item) === key);
	return found >= 0 ? found : clamped;
}
