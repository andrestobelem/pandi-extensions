#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

function parseArgs(argv) {
	const out = { runsRoot: ".pi/workflows/runs", window: 20, out: "", json: "" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--runs-root" && argv[i + 1]) out.runsRoot = argv[++i];
		else if (arg === "--window" && argv[i + 1]) out.window = Math.max(1, Math.floor(Number(argv[++i]) || 20));
		else if (arg === "--out" && argv[i + 1]) out.out = argv[++i];
		else if (arg === "--json" && argv[i + 1]) out.json = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			console.log(
				`Usage: node scripts/report-false-economy.mjs [--runs-root .pi/workflows/runs] [--window 20] [--out report.md] [--json report.json]`,
			);
			process.exit(0);
		}
	}
	return out;
}

function listFiles(dir, predicate) {
	const out = [];
	if (!fs.existsSync(dir)) return out;
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop();
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			const full = path.join(cur, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (!predicate || predicate(full)) out.push(full);
		}
	}
	return out.sort();
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function headerValue(text, key) {
	const match = text.match(new RegExp(`^- ${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : null;
}

function boolHeader(text, key) {
	const value = headerValue(text, key);
	if (value == null) return null;
	if (/^true\b/i.test(value)) return true;
	if (/^false\b/i.test(value)) return false;
	return null;
}

function firstHeading(text, fallback) {
	const match = text.match(/^#\s+(.+)$/m);
	return match ? match[1].trim() : fallback;
}

function parseFocus(text) {
	const focus = headerValue(text, "focus") || "";
	const turns = focus.match(/(\d+)\s+turns/);
	const tools = focus.match(/tools\s+(\d+)\s+\((\d+)\s+err\)/);
	const retries = focus.match(/retries\s+(\d+)/);
	return {
		turns: turns ? Number(turns[1]) : null,
		toolCalls: tools ? Number(tools[1]) : null,
		toolErrors: tools ? Number(tools[2]) : null,
		retries: retries ? Number(retries[1]) : null,
	};
}

function normalizeEffort(raw) {
	if (!raw) return "unknown";
	const value = String(raw).trim().toLowerCase();
	if (value === "minimal") return "low";
	if (value === "max") return "xhigh";
	return value;
}

function rolePrefix(name) {
	const cleaned = String(name || "unknown")
		.replace(/^\d+-/, "")
		.replace(/\.md$/i, "")
		.trim();
	if (!cleaned) return "unknown";
	if (cleaned.includes(":")) return cleaned.split(":")[0] || "unknown";
	const dash = cleaned.match(/^([a-z][a-z0-9]+)(?:[-_][0-9]+)?[-_:]/i);
	if (dash) return dash[1].toLowerCase();
	const token = cleaned.match(/^([a-z][a-z0-9]+)/i);
	return token ? token[1].toLowerCase() : "unknown";
}

function runIdFromAgentPath(file) {
	const parts = file.split(path.sep);
	const agentsIndex = parts.lastIndexOf("agents");
	return agentsIndex > 0 ? parts[agentsIndex - 1] : "unknown-run";
}

function metricsByRun(runsRoot) {
	const map = new Map();
	for (const metricsFile of listFiles(runsRoot, (f) => path.basename(f) === "metrics.json")) {
		const runId = path.basename(path.dirname(metricsFile));
		const metrics = readJson(metricsFile);
		const byName = new Map();
		for (const agent of Array.isArray(metrics?.agents) ? metrics.agents : []) {
			if (agent?.name) byName.set(String(agent.name), agent);
		}
		map.set(runId, byName);
	}
	return map;
}

function parseAgents(runsRoot) {
	const metrics = metricsByRun(runsRoot);
	const files = listFiles(runsRoot, (f) => f.includes(`${path.sep}agents${path.sep}`) && f.endsWith(".md"));
	return files.map((file) => {
		const text = fs.readFileSync(file, "utf8");
		const runId = runIdFromAgentPath(file);
		const name = firstHeading(text, path.basename(file, ".md"));
		const focus = parseFocus(text);
		const metric = metrics.get(runId)?.get(name) || null;
		const turns = focus.turns ?? (Number.isFinite(metric?.turns) ? metric.turns : null);
		const retries = focus.retries ?? (Number.isFinite(metric?.autoRetries) ? metric.autoRetries : null);
		const toolErrors = focus.toolErrors ?? (Number.isFinite(metric?.toolErrors) ? metric.toolErrors : null);
		const schemaOk = boolHeader(text, "schemaOk");
		const model = headerValue(text, "model") || metric?.model || "unknown";
		const effort = normalizeEffort(headerValue(text, "thinking") || headerValue(text, "effort") || metric?.thinking);
		const signals = [];
		if (schemaOk === false) signals.push("schemaOk:false");
		if ((retries ?? 0) > 0) signals.push("retries>0");
		if ((turns ?? 0) > 3) signals.push("turns>3");
		return {
			file,
			runId,
			name,
			rolePrefix: rolePrefix(name),
			model,
			effort,
			ok: boolHeader(text, "ok"),
			schemaOk,
			turns,
			retries,
			toolErrors,
			signals,
		};
	});
}

function summarize(records, windowSize) {
	const groups = new Map();
	for (const record of records) {
		const key = `${record.model}\t${record.effort}\t${record.rolePrefix}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}

	const summaries = [];
	for (const [key, items] of groups) {
		const [model, effort, rolePrefix] = key.split("\t");
		const sorted = [...items].sort((a, b) => `${a.runId}/${a.name}`.localeCompare(`${b.runId}/${b.name}`));
		const window = sorted.slice(-windowSize);
		const schemaFailures = items.filter((r) => r.schemaOk === false).length;
		const retrySignals = items.filter((r) => (r.retries ?? 0) > 0).length;
		const longTurnSignals = items.filter((r) => (r.turns ?? 0) > 3).length;
		const signalCount = items.filter((r) => r.signals.length > 0).length;
		const windowedSignalCount = window.filter((r) => r.signals.length > 0).length;
		const recommendation =
			effort === "low" && windowedSignalCount >= 2 ? "PROMOTE_LOW_TO_MEDIUM" : signalCount > 0 ? "WATCH" : "OK";
		summaries.push({
			model,
			effort,
			rolePrefix,
			agents: items.length,
			schemaFailures,
			retrySignals,
			longTurnSignals,
			signalCount,
			windowedAgents: window.length,
			windowedSignalCount,
			recommendation,
			evidence: window.filter((r) => r.signals.length > 0).slice(-5),
		});
	}

	const severity = { PROMOTE_LOW_TO_MEDIUM: 0, WATCH: 1, OK: 2 };
	return summaries.sort(
		(a, b) =>
			severity[a.recommendation] - severity[b.recommendation] ||
			b.windowedSignalCount - a.windowedSignalCount ||
			b.signalCount - a.signalCount ||
			`${a.rolePrefix}/${a.model}/${a.effort}`.localeCompare(`${b.rolePrefix}/${b.model}/${b.effort}`),
	);
}

function esc(value) {
	return String(value ?? "")
		.replaceAll("|", "\\|")
		.replaceAll("\n", " ");
}

function renderMarkdown(report) {
	const knownModel = report.records.filter((r) => r.model !== "unknown").length;
	const knownEffort = report.records.filter((r) => r.effort !== "unknown").length;
	const lines = [];
	lines.push("# False-economy retrospective");
	lines.push("");
	lines.push(
		`Runs scanned: **${report.runCount}** · agents scanned: **${report.records.length}** · window: **${report.window}**`,
	);
	lines.push("");
	lines.push(
		`Known model: **${knownModel}/${report.records.length}** · known effort: **${knownEffort}/${report.records.length}**`,
	);
	lines.push("");
	lines.push("## Groups");
	lines.push("");
	lines.push(
		"| recommendation | role | model | effort | agents | window signals | schema failures | retries | turns>3 |",
	);
	lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |");
	for (const g of report.groups) {
		lines.push(
			`| ${g.recommendation} | ${esc(g.rolePrefix)} | ${esc(g.model)} | ${esc(g.effort)} | ${g.agents} | ${g.windowedSignalCount}/${g.windowedAgents} | ${g.schemaFailures} | ${g.retrySignals} | ${g.longTurnSignals} |`,
		);
	}
	lines.push("");
	lines.push("## Promotions recommended");
	lines.push("");
	const promotions = report.groups.filter((g) => g.recommendation === "PROMOTE_LOW_TO_MEDIUM");
	if (promotions.length === 0) lines.push("No low-effort group crossed the ≥2-signal threshold in its window.");
	for (const g of promotions) {
		lines.push(`### ${g.rolePrefix} · ${g.model} · ${g.effort}`);
		lines.push("");
		lines.push(`Window signals: ${g.windowedSignalCount}/${g.windowedAgents}. Evidence:`);
		lines.push("");
		for (const r of g.evidence) {
			lines.push(
				`- ${r.runId} · ${r.name} — ${r.signals.join(", ")} (turns=${r.turns ?? "?"}, retries=${r.retries ?? "?"}, schemaOk=${r.schemaOk ?? "?"})`,
			);
		}
		lines.push("");
	}
	lines.push("## Limitations");
	lines.push("");
	lines.push(
		"- Older runs may not record `model` / `thinking`; those are grouped as `unknown` instead of being discarded.",
	);
	lines.push(
		"- This is a retrospective signal detector, not causal proof. Treat recommendations as prompts to inspect the role/prompt before changing defaults.",
	);
	lines.push(
		"- `turns>3`, retries, and schema failures are intentionally coarse false-economy signals; high-turn research agents may be healthy and still show up as WATCH.",
	);
	return `${lines.join("\n")}\n`;
}

function ensureParent(file) {
	if (!file) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const runsRoot = path.resolve(opts.runsRoot);
	const records = parseAgents(runsRoot);
	const runCount = new Set(records.map((r) => r.runId)).size;
	const groups = summarize(records, opts.window);
	const report = { generatedAt: new Date().toISOString(), runsRoot, window: opts.window, runCount, records, groups };
	const md = renderMarkdown(report);
	if (opts.out) {
		ensureParent(opts.out);
		fs.writeFileSync(opts.out, md);
	} else {
		process.stdout.write(md);
	}
	if (opts.json) {
		ensureParent(opts.json);
		fs.writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
	}
}

main();
