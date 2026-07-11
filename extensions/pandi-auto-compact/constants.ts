import type { ContextBarLevel } from "./context-bar.js";

// Clave del estado del footer. setStatus usa esta clave para que esta extensión sea dueña de exactamente un espacio.
export const STATUS_KEY = "auto-compact";

// Nivel de la barra del footer -> token de tema. La barra arranca en verde (`success`) mientras
// el uso está bajo; los estados urgentes (sobre el umbral / compactando) usan `error` para leerse
// como alerta; `accent` se confundía demasiado fácil con selección/logo.
export const BAR_LEVEL_COLOR: Record<ContextBarLevel, "success" | "warning" | "error"> = {
	idle: "success",
	near: "warning",
	over: "error",
	compacting: "error",
};

// Autito ASCII chiquito que encabeza el aviso de activación de la auto-compactación (el
// contexto se "muda" a un resumen). Solo en la activación; completada/falla quedan en texto plano.
export const COMPACT_CAR = ["_/[]\\_", "-o--o-"].join("\n");

export const DEFAULT_SNAPSHOT_KEEP = 20;
