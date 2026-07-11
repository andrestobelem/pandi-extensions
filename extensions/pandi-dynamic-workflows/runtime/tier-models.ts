import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function makeModelArg(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

// Mapeo de alias de nivel (#24): los scaffolds compartidos de doble plataforma usan alias de escalera DESNUDOS
// (haiku/sonnet/opus/fable) para niveles económico/equilibrado/profundo. Fijados a una sesión de Anthropic se
// resuelven de forma nativa, pero otros proveedores no tienen tales alias y la rama falla rápido
// ("modelo no soportado"), por lo que la promesa de nivel económico muere entre proveedores. Esta tabla
// nombra el id que personifica cada nivel por proveedor; anthropic está deliberadamente ausente
// (pi ya resuelve los alias dentro de él). Extiende o anula por proveedor con
// PI_DYNAMIC_WORKFLOWS_TIER_MODELS (JSON de la misma forma) ya que los catálogos cambian rápido.
export const TIER_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);
const BUILTIN_TIER_MODELS: Record<string, Record<string, string>> = {
	"openai-codex": { haiku: "gpt-5.6-luna", sonnet: "gpt-5.6-terra", opus: "gpt-5.6-sol" },
};
export function tierModelTable(): { table: Record<string, Record<string, string>>; error?: string } {
	const raw = process.env.PI_DYNAMIC_WORKFLOWS_TIER_MODELS?.trim();
	if (!raw) return { table: BUILTIN_TIER_MODELS };
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
		const table: Record<string, Record<string, string>> = { ...BUILTIN_TIER_MODELS };
		for (const [provider, tiers] of Object.entries(parsed as Record<string, unknown>)) {
			if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) continue;
			const merged: Record<string, string> = { ...table[provider] };
			for (const [alias, id] of Object.entries(tiers as Record<string, unknown>)) {
				if (typeof id === "string" && id.trim()) merged[alias] = id.trim();
			}
			table[provider] = merged;
		}
		return { table };
	} catch (err) {
		return { table: BUILTIN_TIER_MODELS, error: err instanceof Error ? err.message : String(err) };
	}
}
