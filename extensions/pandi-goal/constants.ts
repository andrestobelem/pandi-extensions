/**
 * Constantes a nivel de módulo para la extensión `/goal`, extraídas a un hermano para que
 * index.ts conserve solo el engine/wiring. Son valores puros (sin cierre sobre estado
 * mutable ni objetos de runtime); cada una se exporta y se importa de nuevo en index.ts,
 * así que el comportamiento y la superficie pública de la extensión no cambian.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/**
 * Nombre del binario de la distribución HOST, leído desde el package.json del host: la
 * primera clave `bin` cuando existe ("pi" en pi vanilla, "picante" en pi-cante), o si no
 * piConfig.name (las distribuciones pueden renombrar el binario independientemente del
 * nombre del producto). Hace fallback a "pi". Duplicado deliberadamente por extensión
 * (regla de extensión autocontenida).
 */
function hostBinName(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as {
			bin?: string | Record<string, string>;
			piConfig?: { name?: string };
		};
		if (pkg.bin && typeof pkg.bin === "object") {
			const first = Object.keys(pkg.bin)[0];
			if (first) return first;
		}
		return pkg.piConfig?.name || "pi";
	} catch {
		return "pi";
	}
}

export const GOAL_STATE_TYPE = "goal-state";
export const GOAL_STATUS_KEY = "goal";
export const DEFAULT_MAX_ITERATIONS = 30;
// Límites opcionales de espera externa (segundos): el modelo solo setea waitSeconds cuando
// espera una señal externa real; por default la reinyección es inmediata (delay 0).
export const MIN_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 3600;
// Cadencia de la red de seguridad cuando un turno cerró sin que el modelo llame a goal_progress.
export const SAFETY_NET_DELAY_SECONDS = 1500;
// Tope best-effort de porcentaje de uso de contexto (detiene si getContextUsage().percent lo excede).
export const DEFAULT_CONTEXT_PERCENT_CAP = 90;
// Cuántas assessments recientes conservar en el log de progreso (continuidad acotada).
export const PROGRESS_LOG_KEEP = 12;
// Cuántos chequeos de completitud propios fallidos (done → verifying → continue) toleramos
// antes de detener el goal como blocked. Defiende contra un ping-pong de "se autodeclara
// done, falla el chequeo, sigue" que consume silenciosamente todo el presupuesto de
// iteraciones sin progreso. DISTINTO de DEFAULT_MAX_INDEPENDENT_VERIFICATIONS abajo: esto
// limita al modelo juzgándose a sí mismo (verifying); aquello limita al juez independiente
// de solo lectura (verifying-independent).
export const MAX_VERIFY_ATTEMPTS = 3;

// --- P1: verificación adversarial independiente (defaults) -------------------
// El subagente verificador (proceso `pi -p` separado) recibe solo tools de solo lectura: juzga,
// nunca muta el workspace.
export const DEFAULT_VERIFIER_TOOLS = ["read", "grep", "find", "ls"] as const;
// Presupuesto de tiempo real para una verificación independiente (ms). Generoso: el
// subagente puede leer archivos y correr algunos greps antes de emitir su veredicto.
export const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;
// Cuántas verificaciones independientes fallidas toleramos antes de detener como blocked.
// Bajo a propósito: un modelo que sigue afirmando done mientras un juez independiente lo
// sigue fallando necesita un humano, no más turnos. DISTINTO de MAX_VERIFY_ATTEMPTS
// arriba: aquello limita el autochequeo (verifying); esto limita al juez independiente
// (verifying-independent). Cada ronda independiente spawnea un proceso `pi -p` separado,
// así que esta compuerta no es gratis: mantenerla baja.
export const DEFAULT_MAX_INDEPENDENT_VERIFICATIONS = 2;
// Comando pi usado para lanzar el subagente verificador (refleja dynamic-workflows.ts).
// Por default usa el binario propio de la distribución HOST (bin name === piConfig.name)
// para que el verificador independiente corra la misma distribución; el override de env
// sigue ganando.
export const PI_COMMAND = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || hostBinName();
