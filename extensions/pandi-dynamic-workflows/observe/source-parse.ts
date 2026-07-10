/**
 * Parsers puros sobre texto JS de workflow source: extraen `basedOn` y literales
 * de propiedades sin evaluar ni tocar el filesystem. El containment de paths queda
 * en el colector.
 */

import type { RunReportBasedOn } from "./html.js";

function readJsStringLiteral(source: string, start: number): { value: string; end: number } | undefined {
	const quote = source[start];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	let value = "";
	for (let i = start + 1; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) return undefined;
			value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
			i++;
			continue;
		}
		if (ch === quote) return { value, end: i + 1 };
		value += ch;
	}
	return undefined;
}

function readBalancedJs(
	source: string,
	start: number,
	open: string,
	close: string,
): { body: string; end: number } | undefined {
	if (source[start] !== open) return undefined;
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const literal = readJsStringLiteral(source, i);
			if (!literal) return undefined;
			i = literal.end - 1;
			continue;
		}
		if (ch === open) depth++;
		if (ch === close) {
			depth--;
			if (depth === 0) return { body: source.slice(start + 1, i), end: i + 1 };
		}
	}
	return undefined;
}

function skipJsWhitespace(source: string, start: number): number {
	let i = start;
	while (i < source.length && /\s/.test(source[i] ?? "")) i++;
	return i;
}

function propertyLiteral(source: string, property: string): string | undefined {
	const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(?:\\b${escapedProperty}\\b|["']${escapedProperty}["'])\\s*:\\s*(["'\\x60])`, "g");
	const match = re.exec(source);
	if (!match) return undefined;
	return readJsStringLiteral(source, match.index + match[0].length - 1)?.value;
}

export function extractRunReportBasedOn(source: string | undefined): RunReportBasedOn[] {
	if (!source) return [];
	const head = source.slice(0, 20_000);
	const metaStart = head.search(/\bexport\s+const\s+meta\s*=/);
	const scan = metaStart >= 0 ? head.slice(metaStart) : head;
	const match = /(?:\bbasedOn\b|["']basedOn["'])\s*:\s*/.exec(scan);
	if (!match) return [];
	const valueStart = skipJsWhitespace(scan, match.index + match[0].length);
	const literal = readJsStringLiteral(scan, valueStart);
	if (literal) return literal.value.trim() ? [{ name: literal.value.trim() }] : [];
	const array = readBalancedJs(scan, valueStart, "[", "]");
	if (!array) return [];
	const out: RunReportBasedOn[] = [];
	for (let i = 0; i < array.body.length; i++) {
		const ch = array.body[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const item = readJsStringLiteral(array.body, i);
			if (item?.value.trim()) out.push({ name: item.value.trim() });
			if (item) i = item.end - 1;
			continue;
		}
		if (ch === "{") {
			const object = readBalancedJs(array.body, i, "{", "}");
			if (!object) continue;
			const name = propertyLiteral(object.body, "name");
			if (name?.trim()) {
				const role = propertyLiteral(object.body, "role");
				const desc = propertyLiteral(object.body, "desc") ?? propertyLiteral(object.body, "description");
				out.push({
					name: name.trim(),
					...(role?.trim() ? { role: role.trim() } : {}),
					...(desc?.trim() ? { desc: desc.trim() } : {}),
				});
			}
			i = object.end - 1;
		}
	}
	return out;
}
