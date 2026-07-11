// Convierte el contrato portable a CommonJS para el contexto de evaluación node:vm del host.
function matchBalancedLiteral(source, start) {
	let index = start;
	while (index < source.length && /\s/.test(source[index])) index++;
	if (source[index] !== "{" && source[index] !== "[") return -1;
	let depth = 0;
	let quote = null;
	for (; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") {
				index++;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			if (newline < 0) return -1;
			index = newline;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) return -1;
			index = end + 1;
			continue;
		}
		if (char === "{" || char === "[") depth++;
		if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/** El formato de authoring es compartido; no admite imports ni exports arbitrarios. */
export function transformWorkflowCode(source) {
	if (/^\s*import\s/m.test(source)) {
		throw new Error(
			"Static import statements are not supported in Cursor workflows. Use injected workflow globals instead.",
		);
	}

	let body = source;
	let meta;
	const declaration = /(^|\n)([ \t]*)export\s+const\s+meta\s*=\s*/.exec(body);
	if (declaration) {
		const start = declaration.index + declaration[0].length;
		const end = matchBalancedLiteral(body, start);
		if (end < 0) throw new Error("Could not parse `export const meta`; it must be a literal object.");
		meta = body.slice(start, end).trim();
		let after = end;
		while (after < body.length && /\s/.test(body[after])) after++;
		if (body[after] === ";") after++;
		body = body.slice(0, declaration.index) + (declaration[1] ?? "") + body.slice(after);
	}

	const hasDefault = /(^|\n)\s*export\s+default\s/.test(body);
	const hasModuleExports = /(^|\n)\s*module\.exports\s*=/.test(body);
	let output;
	if (hasDefault) {
		output = body
			.replace(
				/(^|\n)(\s*)export\s+default\s+async\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
				(_match, newline, indent, name = "") => `${newline}${indent}module.exports = async function${name}(`,
			)
			.replace(
				/(^|\n)(\s*)export\s+default\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
				(_match, newline, indent, name = "") => `${newline}${indent}module.exports = function${name}(`,
			)
			.replace(
				/(^|\n)(\s*)export\s+default\s+async\s*\(/m,
				(_match, newline, indent) => `${newline}${indent}module.exports = async (`,
			)
			.replace(
				/(^|\n)(\s*)export\s+default\s*\(/m,
				(_match, newline, indent) => `${newline}${indent}module.exports = (`,
			)
			.replace(
				/(^|\n)(\s*)export\s+default\s+([^;\n]+);?/m,
				(_match, newline, indent, expression) => `${newline}${indent}module.exports = ${expression};`,
			);
	} else if (hasModuleExports) {
		output = body;
	} else {
		output = `module.exports = async function workflowMain() {\n${body}\n};\n`;
	}
	if (/^\s*export\s/m.test(output)) {
		throw new Error("Only `export const meta` and `export default` are supported in Cursor workflows.");
	}
	if (meta) output += `\ntry { module.exports.meta = ${meta}; } catch {}\n`;
	return output;
}
