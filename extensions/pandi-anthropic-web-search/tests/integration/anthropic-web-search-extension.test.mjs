#!/usr/bin/env node
/**
 * Contrato de la extensión vendorizada de web search nativo de Anthropic.
 * No llama a Anthropic: inspecciona el payload que el lifecycle handler devolvería.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadModule, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ENABLE_ENV = "PI_ANTHROPIC_WEB_SEARCH";
const ALLOWED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_ALLOWED_DOMAINS";
const BLOCKED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_BLOCKED_DOMAINS";
const { check, counts } = createChecker();

function clearEnv() {
	delete process.env[ENABLE_ENV];
	delete process.env[ALLOWED_DOMAINS_ENV];
	delete process.env[BLOCKED_DOMAINS_ENV];
}

function makePi() {
	const handlers = new Map();
	return {
		pi: { on: (event, handler) => handlers.set(event, handler) },
		handlers,
	};
}

async function testPayloadContract(mod) {
	clearEnv();
	const payload = { tools: [{ name: "other_tool" }] };
	const result = mod.addAnthropicWebSearchToPayload("anthropic-messages", payload);
	check(
		"inyecta el tool nativo con el máximo esperado",
		result.tools.some(
			(tool) => tool.type === "web_search_20250305" && tool.name === "web_search" && tool.max_uses === 8,
		),
		JSON.stringify(result),
	);

	const native = { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] };
	const nativeResult = mod.addAnthropicWebSearchToPayload("anthropic-messages", native);
	check(
		"preserva una variante nativa existente sin duplicarla",
		nativeResult.tools.length === 1 && nativeResult.tools[0].type === "web_search_20260209",
		JSON.stringify(nativeResult),
	);

	const functionTool = {
		tools: [{ name: "web_search", description: "búsqueda de función" }, { name: "read" }],
	};
	const replaced = mod.addAnthropicWebSearchToPayload("anthropic-messages", functionTool);
	const searches = replaced.tools.filter((tool) => tool.name === "web_search");
	check(
		"reemplaza el web_search de función por el tool nativo",
		searches.length === 1 &&
			searches[0].type === "web_search_20250305" &&
			replaced.tools.some((tool) => tool.name === "read"),
		JSON.stringify(replaced),
	);

	const nonAnthropic = mod.addAnthropicWebSearchToPayload("openai-responses", functionTool);
	check("no modifica payloads de APIs no Anthropic", nonAnthropic === functionTool);

	process.env[ENABLE_ENV] = "off";
	const disabled = mod.addAnthropicWebSearchToPayload("anthropic-messages", functionTool);
	check("no modifica el payload cuando está desactivada", disabled === functionTool);
	clearEnv();

	process.env[ALLOWED_DOMAINS_ENV] = "docs.anthropic.com, example.com";
	process.env[BLOCKED_DOMAINS_ENV] = "spam.example";
	const filtered = mod.addAnthropicWebSearchToPayload("anthropic-messages", { tools: [] });
	const search = filtered.tools[0];
	check(
		"propaga filtros de dominio configurados",
		JSON.stringify(search.allowed_domains) === JSON.stringify(["docs.anthropic.com", "example.com"]) &&
			JSON.stringify(search.blocked_domains) === JSON.stringify(["spam.example"]),
		JSON.stringify(search),
	);
	clearEnv();
}

async function testLifecycleContract(mod) {
	const { pi, handlers } = makePi();
	mod.default(pi);
	check("registra before_provider_request", typeof handlers.get("before_provider_request") === "function");
	check("no registra before_agent_start", !handlers.has("before_agent_start"));

	const payloadHandler = handlers.get("before_provider_request");
	const payloadResult = await payloadHandler(
		{ payload: { tools: [{ name: "web_search", description: "function" }] } },
		{ model: { api: "anthropic-messages" } },
	);
	check(
		"el handler intercepta requests Anthropic",
		payloadResult.tools.some((tool) => tool.type === "web_search_20250305"),
		JSON.stringify(payloadResult),
	);
}

async function main() {
	const { outDir, aliases } = await makeBuildDir("pandi-anthropic-web-search-integration", {
		sdk: (dir) => sdkStub(dir),
	});
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-anthropic-web-search", "index.ts"),
		outDir,
		outName: "anthropic-web-search.mjs",
		aliases,
	});

	try {
		await testPayloadContract(await loadModule(url));
		await testLifecycleContract(await loadModule(url));
	} finally {
		clearEnv();
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n=== pandi-anthropic-web-search: ${counts.passed} passed, ${counts.failed} failed ===`);
	if (counts.failed > 0) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
