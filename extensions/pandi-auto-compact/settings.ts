// Parsers de configuración para pandi-auto-compact. Las env vars y los argumentos
// de subcomandos de `/auto-compact` comparten esta gramática de on/off + threshold. Puro, sin estado de la extensión;
// se reexportan desde index.ts para que el bundle compilado siga exportando los nombres públicos de parser.

// La compactación se dispara cuando el uso relativo de contexto llega a este porcentaje. Fuente única de
// verdad: index.ts (predeterminado en runtime + descripción del comando) y command-menu.ts (presets,
// marcador "(predeterminado)") derivan de acá. Se puede sobreescribir al iniciar con PI_AUTO_COMPACT_PERCENT.
export const DEFAULT_THRESHOLD_PERCENT = 35;
export const CODEX_DEFAULT_THRESHOLD_PERCENT = 50;

export interface ThresholdModelLike {
	provider?: string;
	api?: string;
	id?: string;
}

export const isCodexModel = (model: ThresholdModelLike | undefined): boolean => {
	const provider = model?.provider?.toLowerCase();
	const api = model?.api?.toLowerCase();
	const id = model?.id?.toLowerCase();
	return provider === "openai-codex" || api === "openai-codex" || id?.includes("codex") === true;
};

export const resolveDefaultThresholdPercent = (model: ThresholdModelLike | undefined): number =>
	isCodexModel(model) ? CODEX_DEFAULT_THRESHOLD_PERCENT : DEFAULT_THRESHOLD_PERCENT;

export const parseThreshold = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number(value.trim().replace(/%$/, ""));
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return undefined;
	return parsed;
};

const ON_VALUES = new Set(["on", "1", "true", "yes", "show"]);
const OFF_VALUES = new Set(["off", "0", "false", "no", "hide"]);

// Parsea una configuración estilo on/off (env var o argumento de subcomando). Devuelve
// undefined para entradas no reconocidas para que quien llama pueda volver a un valor predeterminado.
const parseOnOff = (value: string | undefined): boolean | undefined => {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (ON_VALUES.has(v)) return true;
	if (OFF_VALUES.has(v)) return false;
	return undefined;
};
export const parseBarSetting = parseOnOff;
// Las instantáneas comparten la gramática on/off; se aliasa para que quienes llaman y los tests lean la intención con claridad.
export const parseSnapshotSetting = parseOnOff;

// Parsea el presupuesto de retención de instantáneas (un entero positivo); undefined cuando es inválido
// para que quien llama vuelva a DEFAULT_SNAPSHOT_KEEP.
export const parseSnapshotKeep = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const n = Number(value.trim());
	if (!Number.isInteger(n) || n < 1) return undefined;
	return n;
};

// La limpieza de tool-result comparte la gramática on/off (con alias por intención en los puntos de uso).
export const parseClearSetting = parseOnOff;

// Resuelve un argumento de `/auto-compact <toggle> [on|off]`: un arg vacío invierte el
// valor actual; si no, parsea el token explícito on/off (undefined => no reconocido, así que
// quien llama muestra el uso). Lo comparten los subcomandos bar/snapshot/clear-tools.
export const resolveToggle = (
	arg: string,
	current: boolean,
	parse: (value: string | undefined) => boolean | undefined,
): boolean | undefined => (arg === "" ? !current : parse(arg));
