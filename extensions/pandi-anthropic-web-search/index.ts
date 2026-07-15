/**
 * Búsqueda web nativa para requests `anthropic-messages`.
 *
 * Adaptación vendorizada de code-yeongyu/pi-anthropic-web-search (MIT), fijada en
 * 366396e13abb05a2955d1f66ab703afa1fddee67 para evitar una dependencia runtime externa.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ToolDefinition = Record<string, unknown>;

const WEB_SEARCH_MAX_USES = 8;
const ENABLE_ENV = "PI_ANTHROPIC_WEB_SEARCH";
const ALLOWED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_ALLOWED_DOMAINS";
const BLOCKED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_BLOCKED_DOMAINS";

function parseEnableEnv(envVar: string): boolean {
	const value = process.env[envVar];
	if (!value) return true;

	switch (value.trim().toLowerCase()) {
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNativeWebSearch(tool: ToolDefinition): boolean {
	return typeof tool.type === "string" && tool.type.startsWith("web_search_");
}

function parseDomainListEnv(envVar: string): string[] | undefined {
	const value = process.env[envVar];
	if (!value) return undefined;

	const domains = value
		.split(",")
		.map((domain) => domain.trim())
		.filter(Boolean);
	return domains.length > 0 ? domains : undefined;
}

function makeWebSearchTool(): ToolDefinition {
	const allowedDomains = parseDomainListEnv(ALLOWED_DOMAINS_ENV);
	const blockedDomains = parseDomainListEnv(BLOCKED_DOMAINS_ENV);
	return {
		type: "web_search_20250305",
		name: "web_search",
		max_uses: WEB_SEARCH_MAX_USES,
		...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
		...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
	};
}

/** Conserva tools válidos, pero remueve la variante de función que colisiona con la nativa. */
function sanitizeTools(tools: unknown[]): ToolDefinition[] {
	return tools.filter(isRecord).filter((tool) => !(tool.name === "web_search" && !isNativeWebSearch(tool)));
}

export function isAnthropicWebSearchEnabled(): boolean {
	return parseEnableEnv(ENABLE_ENV);
}

export function addAnthropicWebSearchToPayload(api: string | undefined, payload: unknown): unknown {
	if (api !== "anthropic-messages" || !isAnthropicWebSearchEnabled() || !isRecord(payload)) return payload;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const sanitizedTools = sanitizeTools(tools);
	if (!sanitizedTools.some(isNativeWebSearch)) sanitizedTools.push(makeWebSearchTool());

	return { ...payload, tools: sanitizedTools };
}

export const ANTHROPIC_WEB_SEARCH_SECTION = `
## Web Search

The native web_search tool is available in this session.
Use web_search when the user asks for current or online information.
Prefer web_search over guessing when freshness matters.
`;

function clearUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("pandi-anthropic-web-search", undefined);
	ctx.ui.setWidget("pandi-anthropic-web-search", undefined);
}

export default function anthropicWebSearchExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => addAnthropicWebSearchToPayload(ctx.model?.api, event.payload));

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages" || !isAnthropicWebSearchEnabled()) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${ANTHROPIC_WEB_SEARCH_SECTION}` };
	});

	pi.on("session_start", (_event, ctx) => clearUi(ctx));
	pi.on("model_select", (_event, ctx) => clearUi(ctx));
	pi.on("session_shutdown", (_event, ctx) => clearUi(ctx));
}
