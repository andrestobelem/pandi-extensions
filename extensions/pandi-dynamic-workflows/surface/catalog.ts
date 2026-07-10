/**
 * Reexport del catálogo en lib/ — la API pública de surface conserva el path histórico.
 */
export type { WorkflowPattern } from "../lib/pattern-catalog.js";
export {
	getPatternUseCases,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
} from "../lib/pattern-catalog.js";
