/**
 * Catálogo de patrones de workflow — datos puros + lookup de keys.
 * Vive en lib/ para que tui y surface compartan metadata sin acoplar tui→surface.
 */
import catalogData from "./pattern-catalog.data.json" with { type: "json" };

export interface WorkflowPattern {
	key: string;
	title: string;
	blurb: string;
	useWhen: string;
	inputHint: string;
	primitives: string[];
	defaultName: string;
	category?: "scaffold" | "compose" | "use-case";
	useCases?: string[];
}

export const WORKFLOW_PATTERN_CATALOG: WorkflowPattern[] = catalogData as WorkflowPattern[];

function normalizePatternKey(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.replace(/^adaptive-/, "")
		.replace(/\.(js|mjs|cjs)$/i, "");
}

export function resolveWorkflowPattern(key: string | undefined): WorkflowPattern | undefined {
	if (!key) return undefined;
	const normalized = normalizePatternKey(key);
	return WORKFLOW_PATTERN_CATALOG.find((pattern) => pattern.key === normalized);
}

export function getPatternUseCases(pattern: WorkflowPattern): string[] {
	return pattern.useCases ?? [];
}
