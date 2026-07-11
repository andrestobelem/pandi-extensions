/**
 * Agent view markdown formatting — facade pública que reexporta helpers y builders
 * de la vista de detalle de agente (Card / Prompt / Output).
 */

export { buildAgentViewParts, formatAgentView, resolveAgentArtifactPath } from "./agent-view-output.js";
export { extractMarkdownSection, fencedBlock } from "./agent-view-prompt.js";
export type { AgentViewParts } from "./agent-view-types.js";
