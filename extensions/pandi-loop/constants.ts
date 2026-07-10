/**
 * Constantes a nivel de módulo para la extensión `/loop`, extraídas a un hermano para que
 * index.ts conserve solo el engine/wiring. Son valores puros (sin cierre sobre estado
 * mutable ni objetos de runtime); cada una se exporta y se importa de nuevo en index.ts,
 * así que el comportamiento y la superficie pública de la extensión no cambian.
 *
 * Los defaults de caps del modelo de estado (`DEFAULT_MAX_ITERATIONS`, etc.) viven en
 * state.ts: son del dominio del snapshot, no del tuning operacional del engine.
 */

export const LOOP_STATE_TYPE = "loop-state";
export const LOOP_STATUS_KEY = "loop";
export const LOOP_DIR = "loops";
export const STATE_FILE = "state.json";
// Límite de runtime: cada loop activo posee timer, estado mutable y posible sidecar.
// La rehidratación queda exenta para no perder loops ya creados.
export const MAX_CONCURRENT_LOOPS = 20;
export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3600;
// Fallback cuando el modelo cierra un turno dinámico sin llamar loop_schedule.
export const SAFETY_NET_DELAY_SECONDS = 1500;
// GC solo para sidecars terminales; estados vivos nunca se barren por edad.
export const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días.
// Deadline de respaldo, deliberadamente mayor al wall-clock default, para capturar zombies.
export const WATCHDOG_HARD_DEADLINE_MS = 25 * 60 * 60 * 1000; // 25h.
