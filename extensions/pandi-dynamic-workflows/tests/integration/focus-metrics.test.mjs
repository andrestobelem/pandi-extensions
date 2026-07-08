#!/usr/bin/env node
/**
 * Tests de funciones puras para focus-metrics.ts (research §4 focus observability).
 *
 * parseAgentFocusMetrics pliega un stream stdout de Pi JSON-mode en métricas por agente
 * (crecimiento de tokens, tasa de tool-error, retries); aggregateRunFocusMetrics las agrega.
 * Contar usage SOLO desde message_end evita doble conteo del mensaje assistant repetido
 * que turn_end/agent_end también llevan. Todo es tolerante + fail-safe.
 *
 * focus-metrics.ts no tiene imports, así que bundlea standalone (sin stubs necesarios).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-focus-metrics",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "focus-metrics.ts"),
		outName: "focus-metrics.mjs",
		npx: "--no-install",
	});
	return await import(url);
}

// --- Builders de líneas JSON-mode --------------------------------------------
const msgEnd = (input, output, total, cost, { cacheRead = 0, cacheWrite = 0 } = {}) =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			usage: { input, output, totalTokens: total, cacheRead, cacheWrite, cost: { total: cost } },
		},
	});
const turnEnd = (input, output, total, cost) =>
	JSON.stringify({
		type: "turn_end",
		message: {
			role: "assistant",
			usage: { input, output, totalTokens: total, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
		},
		toolResults: [],
	});
const agentEnd = (input, output, total, cost) =>
	JSON.stringify({
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				usage: { input, output, totalTokens: total, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
			},
		],
	});
const toolEnd = (isError) =>
	JSON.stringify({ type: "tool_execution_end", toolCallId: "tc", toolName: "read", result: {}, isError });
const retryEnd = () => JSON.stringify({ type: "auto_retry_end", success: true, attempt: 1 });

const META = { id: 1, name: "scout", ok: true, elapsedMs: 1234 };

async function main() {
	const mod = await loadModule();
	const { parseAgentFocusMetrics, aggregateRunFocusMetrics, formatFocusMetricsMarkdown } = mod;

	// 1) Crecimiento de tokens + tool-error + retries desde un stream realista.
	const stdout = [
		JSON.stringify({ type: "agent_start" }),
		msgEnd(1000, 50, 1050, 0.01),
		toolEnd(false),
		toolEnd(true),
		msgEnd(1500, 30, 1530, 0.012), // input creció → peak 1500
		retryEnd(),
		// turn_end + agent_end repiten el MISMO último mensaje — NO debe contarse doble.
		turnEnd(1500, 30, 1530, 0.012),
		agentEnd(1500, 30, 1530, 0.012),
	].join("\n");
	const m = parseAgentFocusMetrics(stdout, META);
	check(
		"parse: counts only message_end turns (no double count from turn_end/agent_end)",
		m.turns === 2,
		`turns=${m.turns}`,
	);
	check(
		"parse: inputTokensPeak is the max input across calls",
		m.inputTokensPeak === 1500,
		`peak=${m.inputTokensPeak}`,
	);
	check("parse: outputTokensTotal sums generation", m.outputTokensTotal === 80, `out=${m.outputTokensTotal}`);
	check("parse: totalTokens is the peak per-call total", m.totalTokens === 1530, `total=${m.totalTokens}`);
	check("parse: costTotal sums per-call cost", Math.abs(m.costTotal - 0.022) < 1e-9, `cost=${m.costTotal}`);
	check("parse: toolCalls counted", m.toolCalls === 2, `toolCalls=${m.toolCalls}`);
	check("parse: toolErrors counted (isError:true)", m.toolErrors === 1, `toolErrors=${m.toolErrors}`);
	check("parse: autoRetries counted", m.autoRetries === 1, `retries=${m.autoRetries}`);
	check(
		"parse: carries meta (id/name/ok/elapsedMs)",
		m.id === 1 && m.name === "scout" && m.ok === true && m.elapsedMs === 1234,
	);

	// 2) Fail-safe ante input vacío / basura / parcial.
	const empty = parseAgentFocusMetrics("", META);
	check(
		"failsafe: empty stdout → zeroed metrics",
		empty.turns === 0 && empty.inputTokensPeak === 0 && empty.toolCalls === 0,
	);
	const garbage = parseAgentFocusMetrics("not json\n{partial\n\n", META);
	check("failsafe: garbage/partial lines skipped → zeroed", garbage.turns === 0 && garbage.outputTokensTotal === 0);
	const mixed = parseAgentFocusMetrics(["{bad", msgEnd(200, 5, 205, 0.001), "also bad"].join("\n"), META);
	check("failsafe: valid lines still counted amid invalid ones", mixed.turns === 1 && mixed.inputTokensPeak === 200);

	// 2b) Prompt caching: providers reportan tokens de prompt cacheados en cacheRead/cacheWrite,
	// dejando usage.input diminuto (~2 tok observado en producción con caching de Anthropic).
	// La presión REAL de contexto por call es input + cacheRead + cacheWrite.
	const cached = parseAgentFocusMetrics(
		[
			msgEnd(2, 54, 7470, 0.095, { cacheRead: 0, cacheWrite: 7414 }),
			msgEnd(2, 100, 110002, 0.1, { cacheRead: 100000, cacheWrite: 10000 }),
		].join("\n"),
		META,
	);
	check(
		"cache-aware: inputTokensPeak includes cacheRead+cacheWrite (real context pressure)",
		cached.inputTokensPeak === 110002,
		`peak=${cached.inputTokensPeak}`,
	);
	check(
		"cache-aware: cache totals still summed separately",
		cached.cacheReadTotal === 100000 && cached.cacheWriteTotal === 17414,
		`read=${cached.cacheReadTotal} write=${cached.cacheWriteTotal}`,
	);

	// 3) Agregá entre agentes: rollup + tasa de tool-error + trajectory ordenada.
	const a2 = parseAgentFocusMetrics(msgEnd(500, 10, 510, 0.002), { id: 2, name: "synth", ok: false, elapsedMs: 50 });
	const agg = aggregateRunFocusMetrics([a2, m]); // pasá fuera de orden para probar sorting por id
	check("aggregate: measuredAgents", agg.measuredAgents === 2, `n=${agg.measuredAgents}`);
	check("aggregate: ok/failed split", agg.okAgents === 1 && agg.failedAgents === 1);
	check("aggregate: inputTokensPeak is max across agents", agg.inputTokensPeak === 1500);
	check(
		"aggregate: outputTokensTotal sums across agents",
		agg.outputTokensTotal === 90,
		`out=${agg.outputTokensTotal}`,
	);
	check(
		"aggregate: toolErrorRate = errors/calls",
		Math.abs(agg.toolErrorRate - 0.5) < 1e-9,
		`rate=${agg.toolErrorRate}`,
	);
	check("aggregate: autoRetries summed", agg.autoRetries === 1);
	check("aggregate: agentElapsedMsTotal sums durations", agg.agentElapsedMsTotal === 1284);
	check("aggregate: agents ordered by id (trajectory)", agg.agents.map((x) => x.id).join(",") === "1,2");

	// 4) El reporte Markdown renderiza + nota calls cacheadas excluidas.
	const md = formatFocusMetricsMarkdown(agg, { cachedCalls: 3 });
	check(
		"format: includes the header + a trajectory table",
		/# Focus metrics/.test(md) && /Per-step trajectory/.test(md),
	);
	check("format: surfaces tool-error rate", /toolErrorRate: 50\.0%/.test(md), md.slice(0, 120));
	check("format: notes excluded cached/resumed calls", /3 cached\/resumed call\(s\)/.test(md));
	const mdNoCache = formatFocusMetricsMarkdown(agg, {});
	check("format: no cached-note when none excluded", !/cached\/resumed call/.test(mdNoCache));
	// Un nombre de agente provisto por workflow con pipe/newline no debe romper la tabla Markdown.
	const piped = parseAgentFocusMetrics("", { id: 9, name: "a|b\nc", ok: true, elapsedMs: 0 });
	const mdEscaped = formatFocusMetricsMarkdown(aggregateRunFocusMetrics([piped]), {});
	const row = mdEscaped.split("\n").find((l) => l.includes("a"));
	check("format: escapes pipe in agent name (no raw table-breaking |)", /a\\\|b c/.test(mdEscaped), row);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
