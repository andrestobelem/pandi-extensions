/**
 * Resolución y parseo del valor por defecto de copia de worktrees (la superficie "pasar por llamada o set").
 *
 * Refleja el patrón flags.ts de pandi-plan, mantenido AUTOCONTENIDO en esta
 * extensión (duplicación intencional por extensión — NO un import cross-extension
 * a `../shared/` — para que la extensión siga funcionando cuando se instala
 * standalone).
 *
 * `--copy-ignored` / `--copy-untracked` (y los params copyIgnored/copyUntracked
 * de la herramienta) ya permiten que quien llama active la copia por llamada. Esto suma
 * la superficie que faltaba para `set`: un valor por defecto de sesión
 * (`/worktree set copy-ignored on|off`) y uno de entorno, más la capacidad de
 * desactivar la copia por llamada (`--no-copy-ignored`) para sobrescribir un
 * valor por defecto en ON.
 *
 * Precedencia (de mayor a menor): param explícito por llamada (true/false) ->
 * valor por defecto de sesión -> entorno (PI_WORKTREE_COPY_*) -> false.
 *
 * `sessionCopyDefaults` es estado mutable a nivel de módulo. Su identidad
 * singleton de ES vive ACÁ (un objeto, mutado solo a través de las funciones de
 * abajo). index.ts NO debe re-declararlo: escribe/lee vía
 * set/reset/resolveCopyPrefs. Módulo hermano de profundidad uno importado por
 * index.ts/command.ts vía "./copy-prefs.js".
 */

/** Un ajuste está en ON cuando la env var es uno de los tokens truthy (1/true/on/yes). */
export function envFlag(name: string): boolean {
	const value = (process.env[name] ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "on" || value === "yes";
}

/** Preferencias de copia tri-state: undefined = "sin especificar, seguir al siguiente valor". */
export interface CopyPrefs {
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

/** Claves de los toggles de copia por defecto de la sesión. */
export type CopyPrefKey = "copyIgnored" | "copyUntracked";

/**
 * Valores por defecto a nivel de sesión definidos por
 * `/worktree set copy-ignored|copy-untracked on|off`. Quedan ENTRE un param
 * explícito por llamada y el valor de env, y se reinician en cada límite de
 * sesión (ver el hook session_start de index.ts).
 */
const sessionCopyDefaults: CopyPrefs = {};

export function resetSessionCopyDefaults(): void {
	sessionCopyDefaults.copyIgnored = undefined;
	sessionCopyDefaults.copyUntracked = undefined;
}

/** Define un toggle por defecto de la sesión (true/false). */
export function setSessionCopyDefault(key: CopyPrefKey, value: boolean): void {
	sessionCopyDefaults[key] = value;
}

/**
 * Resuelve las preferencias de copia con precedence: param explícito por
 * llamada (true/false) -> valor por defecto de sesión -> entorno
 * (PI_WORKTREE_COPY_*) -> false. Devuelve booleanos concretos para que quien
 * llama y la nota de copia nunca vean undefined.
 */
export function resolveCopyPrefs(params: CopyPrefs): { copyIgnored: boolean; copyUntracked: boolean } {
	return {
		copyIgnored: params.copyIgnored ?? sessionCopyDefaults.copyIgnored ?? envFlag("PI_WORKTREE_COPY_IGNORED"),
		copyUntracked: params.copyUntracked ?? sessionCopyDefaults.copyUntracked ?? envFlag("PI_WORKTREE_COPY_UNTRACKED"),
	};
}

const COPY_TOGGLE_ON_TOKENS = new Set(["on", "enable", "enabled", "true", "1"]);
const COPY_TOGGLE_OFF_TOKENS = new Set(["off", "disable", "disabled", "false", "0"]);

/** Parsea un argumento de toggle on|off|status (con aliases comunes). */
export function parseCopyToggleValue(raw: string): "on" | "off" | "status" | "invalid" {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (COPY_TOGGLE_ON_TOKENS.has(value)) return "on";
	if (COPY_TOGGLE_OFF_TOKENS.has(value)) return "off";
	return "invalid";
}
