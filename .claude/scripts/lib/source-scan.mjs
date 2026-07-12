// Extracción conservadora para previews parse-only. Solo interpreta literales
// JSON-like y llamadas conocidas; nunca evalúa ni importa el workflow.

import { fallbackMeta } from "./util.mjs";

const CALL_NAMES = new Set(["agent", "agents", "parallel", "phase", "workflow"]);

function skipSpaceAndComments(source, start) {
	let i = start;
	while (i < source.length) {
		if (/\s/.test(source[i])) {
			i++;
			continue;
		}
		if (source.startsWith("//", i)) {
			i = source.indexOf("\n", i + 2);
			if (i < 0) return source.length;
			continue;
		}
		if (source.startsWith("/*", i)) {
			i = source.indexOf("*/", i + 2);
			if (i < 0) return source.length;
			i += 2;
			continue;
		}
		break;
	}
	return i;
}

function skipQuoted(source, start) {
	const quote = source[start];
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === quote) return i + 1;
		i++;
	}
	return source.length;
}

function matchingDelimiter(source, start) {
	const pairs = { "(": ")", "[": "]", "{": "}" };
	const close = pairs[source[start]];
	if (!close) return -1;
	let depth = 1;
	for (let i = start + 1; i < source.length; i++) {
		if (source.startsWith("//", i)) {
			i = source.indexOf("\n", i + 2);
			if (i < 0) return -1;
			continue;
		}
		if (source.startsWith("/*", i)) {
			i = source.indexOf("*/", i + 2);
			if (i < 0) return -1;
			i++;
			continue;
		}
		if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
			i = skipQuoted(source, i) - 1;
			continue;
		}
		if (source[i] === source[start]) depth++;
		else if (source[i] === close && --depth === 0) return i;
	}
	return -1;
}

function splitTopLevel(source, separator = ",") {
	const parts = [];
	let start = 0;
	const stack = [];
	for (let i = 0; i < source.length; i++) {
		if (source.startsWith("//", i)) {
			const next = source.indexOf("\n", i + 2);
			i = next < 0 ? source.length : next;
			continue;
		}
		if (source.startsWith("/*", i)) {
			const next = source.indexOf("*/", i + 2);
			i = next < 0 ? source.length : next + 1;
			continue;
		}
		if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
			i = skipQuoted(source, i) - 1;
			continue;
		}
		if ("([{".includes(source[i])) stack.push(source[i]);
		else if (")]}".includes(source[i])) stack.pop();
		else if (source[i] === separator && stack.length === 0) {
			parts.push(source.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(source.slice(start).trim());
	return parts.filter(Boolean);
}

function topLevelColon(source) {
	const stack = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
			i = skipQuoted(source, i) - 1;
			continue;
		}
		if ("([{".includes(source[i])) stack.push(source[i]);
		else if (")]}".includes(source[i])) stack.pop();
		else if (source[i] === ":" && stack.length === 0) return i;
	}
	return -1;
}

function decodeString(source, start = 0) {
	const quote = source[start];
	if (!["'", '"', "`"].includes(quote)) return null;
	let value = "";
	for (let i = start + 1; i < source.length; i++) {
		const char = source[i];
		if (char === quote) return { value, end: i + 1 };
		if (char !== "\\") {
			value += char;
			continue;
		}
		const escaped = source[++i];
		if (escaped == null) return null;
		const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
		if (escaped in simple) value += simple[escaped];
		else if (escaped === "\n") {
			// Continuación de línea.
		} else if (escaped === "x" && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
			value += String.fromCharCode(Number.parseInt(source.slice(i + 1, i + 3), 16));
			i += 2;
		} else if (escaped === "u" && /^[0-9a-f]{4}$/i.test(source.slice(i + 1, i + 5))) {
			value += String.fromCharCode(Number.parseInt(source.slice(i + 1, i + 5), 16));
			i += 4;
		} else value += escaped;
	}
	return null;
}

function templateText(expression) {
	const decoded = decodeString(expression.trim());
	if (!decoded) return undefined;
	return decoded.value.replace(/\$\{[\s\S]*?\}/g, "‹runtime value›");
}

function literalString(expression) {
	const source = expression.trim();
	if (!["'", '"', "`"].includes(source[0])) return undefined;
	const decoded = decodeString(source);
	if (!decoded) return undefined;
	if (source[0] === "`") return templateText(source);
	return decoded.value;
}

class LiteralParser {
	constructor(source) {
		this.source = source;
		this.index = 0;
	}

	skip() {
		this.index = skipSpaceAndComments(this.source, this.index);
	}

	parse() {
		this.skip();
		const value = this.value();
		this.skip();
		if (this.index !== this.source.length) throw new Error("non-literal expression");
		return value;
	}

	value() {
		this.skip();
		const char = this.source[this.index];
		if (char === "{") return this.object();
		if (char === "[") return this.array();
		if (char === "'" || char === '"' || char === "`") {
			const decoded = decodeString(this.source, this.index);
			if (!decoded || (char === "`" && decoded.value.includes("${"))) throw new Error("dynamic template");
			this.index = decoded.end;
			return decoded.value;
		}
		const number = this.source.slice(this.index).match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
		if (number) {
			this.index += number[0].length;
			return Number(number[0]);
		}
		const identifier = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
		if (!identifier) throw new Error("unsupported literal");
		this.index += identifier[0].length;
		if (identifier[0] === "true") return true;
		if (identifier[0] === "false") return false;
		if (identifier[0] === "null") return null;
		if (identifier[0] === "undefined") return undefined;
		throw new Error("computed identifier");
	}

	object() {
		const value = {};
		this.index++;
		while (true) {
			this.skip();
			if (this.source[this.index] === "}") {
				this.index++;
				return value;
			}
			let key;
			if (["'", '"'].includes(this.source[this.index])) {
				const decoded = decodeString(this.source, this.index);
				if (!decoded) throw new Error("invalid object key");
				key = decoded.value;
				this.index = decoded.end;
			} else {
				const identifier = this.source.slice(this.index).match(/^[A-Za-z_$][\w$-]*/);
				if (!identifier) throw new Error("computed object key");
				key = identifier[0];
				this.index += identifier[0].length;
			}
			this.skip();
			if (this.source[this.index++] !== ":") throw new Error("missing object colon");
			value[key] = this.value();
			this.skip();
			if (this.source[this.index] === ",") {
				this.index++;
				continue;
			}
			if (this.source[this.index] !== "}") throw new Error("missing object close");
		}
	}

	array() {
		const value = [];
		this.index++;
		while (true) {
			this.skip();
			if (this.source[this.index] === "]") {
				this.index++;
				return value;
			}
			value.push(this.value());
			this.skip();
			if (this.source[this.index] === ",") {
				this.index++;
				continue;
			}
			if (this.source[this.index] !== "]") throw new Error("missing array close");
		}
	}
}

function parseLiteral(expression) {
	try {
		return new LiteralParser(expression).parse();
	} catch {
		return undefined;
	}
}

function objectProperties(expression) {
	const source = expression.trim();
	if (source[0] !== "{") return new Map();
	const close = matchingDelimiter(source, 0);
	if (close < 0) return new Map();
	const properties = new Map();
	for (const part of splitTopLevel(source.slice(1, close))) {
		const colon = topLevelColon(part);
		if (colon < 0) continue;
		const rawKey = part.slice(0, colon).trim();
		const key = literalString(rawKey) ?? (/^[A-Za-z_$][\w$]*$/.test(rawKey) ? rawKey : undefined);
		if (key) properties.set(key, part.slice(colon + 1).trim());
	}
	return properties;
}

function scanCalls(source) {
	const calls = [];
	for (let i = 0; i < source.length; i++) {
		if (source.startsWith("//", i)) {
			const next = source.indexOf("\n", i + 2);
			i = next < 0 ? source.length : next;
			continue;
		}
		if (source.startsWith("/*", i)) {
			const next = source.indexOf("*/", i + 2);
			i = next < 0 ? source.length : next + 1;
			continue;
		}
		if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
			i = skipQuoted(source, i) - 1;
			continue;
		}
		if (!/[A-Za-z_$]/.test(source[i])) continue;
		const match = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
		if (!match) continue;
		const name = match[0];
		const afterName = skipSpaceAndComments(source, i + name.length);
		if (CALL_NAMES.has(name) && source[afterName] === "(") {
			const close = matchingDelimiter(source, afterName);
			if (close >= 0) {
				calls.push({
					name,
					index: i,
					open: afterName,
					close,
					args: splitTopLevel(source.slice(afterName + 1, close)),
				});
			}
		}
		i += name.length - 1;
	}
	return calls;
}

function scanLiteralConstants(source) {
	const values = new Map();
	const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
	let match;
	while ((match = pattern.exec(source))) {
		const start = skipSpaceAndComments(source, pattern.lastIndex);
		if (!["{", "["].includes(source[start])) continue;
		const close = matchingDelimiter(source, start);
		if (close < 0) continue;
		const value = parseLiteral(source.slice(start, close + 1));
		if (value !== undefined) values.set(match[1], value);
	}
	return values;
}

function staticValue(expression, constants) {
	const literal = parseLiteral(expression);
	if (literal !== undefined) return literal;
	const identifier = expression.trim();
	return constants.get(identifier);
}

function helperOptions(expression) {
	const source = expression.trim();
	const match = source.match(/^node\s*\(/);
	if (!match) return { role: undefined, properties: objectProperties(source) };
	const open = source.indexOf("(", match.index);
	const close = matchingDelimiter(source, open);
	if (close < 0) return { role: undefined, properties: new Map() };
	const args = splitTopLevel(source.slice(open + 1, close));
	return { role: literalString(args[0] || ""), properties: objectProperties(args[1] || "") };
}

function fieldString(properties, name) {
	const expression = properties.get(name);
	return expression == null ? undefined : literalString(expression);
}

function dynamicRole(value) {
	if (!value?.includes("‹runtime value›")) return value;
	const stable = value.replace(/[-_.:/\s]*‹runtime value›.*$/, "").trim();
	return stable || undefined;
}

function scanMeta(source, scriptPath) {
	const match = /\bexport\s+const\s+meta\s*=\s*/g.exec(source);
	if (!match) return { meta: fallbackMeta(scriptPath), partial: true };
	const start = skipSpaceAndComments(source, match.index + match[0].length);
	if (source[start] !== "{") return { meta: fallbackMeta(scriptPath), partial: true };
	const close = matchingDelimiter(source, start);
	if (close < 0) return { meta: fallbackMeta(scriptPath), partial: true };
	const value = parseLiteral(source.slice(start, close + 1));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { meta: fallbackMeta(scriptPath), partial: true };
	}
	return { meta: { ...fallbackMeta(scriptPath), ...value }, partial: false };
}

export function scanPreviewSource({ scriptPath, raw }) {
	const calls = scanCalls(raw);
	const constants = scanLiteralConstants(raw);
	const metaResult = scanMeta(raw, scriptPath);
	const phaseCalls = calls
		.filter((call) => call.name === "phase")
		.map((call) => ({ index: call.index, title: literalString(call.args[0] || "") }))
		.filter((call) => call.title);
	const declaredPhases = Array.isArray(metaResult.meta.phases)
		? metaResult.meta.phases.map((phase) => (typeof phase === "string" ? phase : phase?.title)).filter(Boolean)
		: [];
	const phases = [...new Set([...declaredPhases, ...phaseCalls.map((call) => call.title)])];
	const parallelRanges = calls
		.filter((call) => call.name === "parallel")
		.map((call) => ({ open: call.open, close: call.close }));
	const nodes = [];
	const declared = new Map();
	let partial = metaResult.partial;

	for (const call of calls.filter((entry) => entry.name === "agent" || entry.name === "agents")) {
		const optionsExpression = call.args[1] || "";
		const { role: helperRole, properties } = helperOptions(optionsExpression);
		const rawLabel = fieldString(properties, "label") ?? fieldString(properties, "name") ?? helperRole;
		const label = dynamicRole(rawLabel);
		const nearestPhase = phaseCalls.filter((phase) => phase.index < call.index).at(-1)?.title;
		const phase = fieldString(properties, "phase") ?? nearestPhase;
		const prompt = literalString(call.args[0] || "") ?? "‹prompt calculado en runtime›";
		const schemaExpression = properties.get("schema");
		const schema = schemaExpression ? staticValue(schemaExpression, constants) : undefined;
		const items = call.name === "agents" ? staticValue(call.args[0] || "", constants) : undefined;
		const instances = Array.isArray(items) && items.length ? items.length : 1;
		const isParallel = parallelRanges.some((range) => call.index > range.open && call.index < range.close);
		const dynamic = rawLabel?.includes("‹runtime value›") || prompt.includes("‹runtime value›");
		const node = {
			prompt,
			label: label || `${call.name}-${nodes.length + 1}`,
			phase,
			schema,
			model: fieldString(properties, "model"),
			effort: fieldString(properties, "effort"),
			tools: staticValue(properties.get("tools") || "", constants),
			skills: staticValue(properties.get("skills") || "", constants),
			extensions: staticValue(properties.get("extensions") || "", constants),
			instances,
			parallel: isParallel || instances > 1,
		};
		if (label) {
			const previous = declared.get(label) || {};
			declared.set(label, {
				phase: previous.phase ?? phase,
				model: previous.model ?? node.model,
				effort: previous.effort ?? node.effort,
				schema: previous.schema ?? schema,
				parallel: previous.parallel || isParallel || instances > 1,
			});
		}
		if (!label || !phase || dynamic || (schemaExpression && schema === undefined)) partial = true;
		// Un fan-out cuyo label/cardinalidad depende de runtime no es un nodo concreto en pre-run.
		// La declaración queda disponible para que un run real lo materialice con sus eventos.
		if (!(dynamic && isParallel)) nodes.push(node);
	}

	const composes = [
		...new Set(
			calls
				.filter((call) => call.name === "workflow")
				.map((call) => literalString(call.args[0] || ""))
				.filter(Boolean),
		),
	];
	if (calls.some((call) => call.name === "workflow" && !literalString(call.args[0] || ""))) partial = true;

	const fidelity = partial
		? [
				"preview parse-only parcial — ramas, opciones calculadas y cardinalidad dinámica pueden faltar; " +
					"usá --eval-preview solo si aceptás evaluar explícitamente el source con stubs",
			]
		: [];

	return {
		meta: metaResult.meta,
		nodes,
		phases,
		composes,
		declared,
		fidelity,
		runErr: null,
		pipeErr: null,
	};
}
