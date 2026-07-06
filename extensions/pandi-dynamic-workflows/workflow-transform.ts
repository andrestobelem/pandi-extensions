// Escanea un literal de objeto/array JS comenzando en/después de `start`, retornando el índice justo después
// de su cierre coincidente (consciente de string/comentario de línea+bloque). -1 si no se puede equilibrar. Se usa para
// extraer `export const meta = { ... }` de un flujo de trabajo sin una regex de llave frágil.
function matchBalancedLiteral(src: string, start: number): number {
	let i = start;
	while (i < src.length && /\s/.test(src[i])) i++;
	const open = src[i];
	if (open !== "{" && open !== "[") return -1;
	let depth = 0;
	let inStr: string | null = null;
	for (; i < src.length; i++) {
		const c = src[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) return -1;
			i = end + 1;
			continue;
		}
		if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

// Compila la fuente escrita de un flujo de trabajo en CommonJS que puede ejecutar el Worker. El contrato de autoría único
// es un script de nivel superior que usa los globals inyectados (agent, parallel, pipeline,
// workflow, phase, log, args), opcionalmente declara `export const meta = { ... }`, y termina con
// `return <value>`. Extraemos `meta`, luego envolvemos el cuerpo en una función async para que su nivel superior
// `await`/`return` sean legales. (Una forma legacy `export default function` sigue siendo aceptada mientras
// el código migra; se elimina una vez que todos los scaffolds/tests usan la interfaz única.)
export function transformWorkflowCode(code: string): string {
	if (/^\s*import\s/m.test(code)) {
		throw new Error(
			"Static import statements are not supported in workflows. Use the injected globals (agent, parallel, pipeline, workflow, phase, log, args).",
		);
	}

	// 1) Lift `export const meta = <object literal>;` (a pure literal by convention) so it neither
	//    trips the export check below nor lands inside the wrapper function.
	let body = code;
	let metaLiteral: string | undefined;
	const metaDecl = /(^|\n)([ \t]*)export\s+const\s+meta\s*=\s*/.exec(body);
	if (metaDecl) {
		const litStart = metaDecl.index + metaDecl[0].length;
		const litEnd = matchBalancedLiteral(body, litStart);
		if (litEnd < 0)
			throw new Error("Could not parse `export const meta = { ... }`; keep meta a pure object literal.");
		metaLiteral = body.slice(litStart, litEnd).trim();
		let after = litEnd;
		while (after < body.length && /\s/.test(body[after])) after++;
		if (body[after] === ";") after++;
		body = body.slice(0, metaDecl.index) + (metaDecl[1] ?? "") + body.slice(after);
	}

	// 2) Elige la forma de compilación:
	//    - legacy `export default ...`  -> reescribe a `module.exports = ...` (transitional).
	//    - legacy directo `module.exports = ...` -> pasa (transitional).
	//    - nuevo script de nivel superior (ninguno) -> envuelve para que `await`/`return` de nivel superior sean legales.
	const usesExportDefault = /(^|\n)\s*export\s+default\s/.test(body);
	const assignsModuleExports = /(^|\n)\s*module\.exports\s*=/.test(body);
	let output: string;
	if (usesExportDefault) {
		output = body
			.replace(
				/(^|\n)(\s*)export\s+default\s+async\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
				(_m, nl, ind, name = "") => `${nl}${ind}module.exports = async function${name}(`,
			)
			.replace(
				/(^|\n)(\s*)export\s+default\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
				(_m, nl, ind, name = "") => `${nl}${ind}module.exports = function${name}(`,
			)
			.replace(/(^|\n)(\s*)export\s+default\s+async\s*\(/m, (_m, nl, ind) => `${nl}${ind}module.exports = async (`)
			.replace(/(^|\n)(\s*)export\s+default\s*\(/m, (_m, nl, ind) => `${nl}${ind}module.exports = (`)
			.replace(
				/(^|\n)(\s*)export\s+default\s+([^;\n]+);?/m,
				(_m, nl, ind, expr) => `${nl}${ind}module.exports = ${expr};`,
			);
		if (/^\s*export\s/m.test(output)) {
			throw new Error(
				"Unexpected `export` in workflow. Write a top-level script that ends with `return <value>` plus an optional `export const meta = { ... }` (no other exports).",
			);
		}
	} else if (assignsModuleExports) {
		if (/^\s*export\s/m.test(body)) {
			throw new Error(
				"Unexpected `export` in workflow. Use `module.exports = ...`, or a top-level script that ends with `return <value>` plus an optional `export const meta = { ... }`.",
			);
		}
		output = body;
	} else {
		if (/^\s*export\s/m.test(body)) {
			throw new Error(
				"Only `export const meta = { ... }` is allowed as an export. Write a top-level script that ends with `return <value>`.",
			);
		}
		output = `module.exports = async function workflowMain() {\n${body}\n};\n`;
	}

	if (metaLiteral !== undefined) {
		output += `\ntry { module.exports.meta = ${metaLiteral}; } catch (_e) {}\n`;
	}
	return output;
}
