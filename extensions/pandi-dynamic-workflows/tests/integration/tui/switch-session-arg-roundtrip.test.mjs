#!/usr/bin/env node
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

// Espejo de command-handlers.ts: split action/arg aplicado a los args trimmeados.
const ACTION_SPLIT = /^(\S+)(?:\s+([\s\S]*))?$/;

/** Lo que el handler ve como `afterAction` para el comando /workflow enviado. */
function handlerAfterAction(submittedArgs) {
	const m = ACTION_SPLIT.exec(submittedArgs.trim());
	return m?.[2]?.trimStart() ?? "";
}

async function loadRuntime() {
	const { url } = await buildDwfModule({
		name: "pi-dw-switch-session-arg",
		relPath: "tui/orchestration.ts",
		outName: "dashboard-orchestration.mjs",
		stubs: { sdk: (dir) => dir && "" },
	});
	return await loadModule(url);
}

async function main() {
	const { parseWorkflowCommandArgument } = await loadRuntime();
	check(
		"exports parseWorkflowCommandArgument",
		typeof parseWorkflowCommandArgument === "function",
		typeof parseWorkflowCommandArgument,
	);

	// Paths de archivo de sesión Pi del mundo real que DEBEN sobrevivir el viaje producer→handler→parser.
	const paths = [
		"/Users/me/.pi/sessions/a.json",
		"/Users/me/My Sessions/with spaces.json",
		"/tmp/únïcode/sesión.json",
		'/a/"weird"/b.json',
		"C:\\Users\\me\\AppData\\s.json",
		"/path/with\ttab.json",
		"   /leading-and-trailing.json   ",
		"relative/path.json",
	];

	// 1) Invariante central sobre el helper exportado: invierte el JSON.stringify del producer.
	for (const p of paths) {
		const quoted = JSON.stringify(p); // === quoteWorkflowCommandArgument(p)
		check(
			`parse(JSON.stringify(path)) round-trips: ${JSON.stringify(p)}`,
			parseWorkflowCommandArgument(quoted) === p,
			`quoted=${quoted} got=${JSON.stringify(parseWorkflowCommandArgument(quoted))}`,
		);
	}

	// 2) Ruta completa como realmente la corre el handler: construir el comando enviado, aplicar el
	//    split tokenizer del handler, luego parsear; el arg quoted no debe corromperse por el
	//    split de whitespace incluso cuando el path contiene espacios/tabs.
	for (const p of paths) {
		const submitted = `switch-session ${JSON.stringify(p)}`;
		const recovered = parseWorkflowCommandArgument(handlerAfterAction(submitted));
		check(
			`handler split + parse round-trips: ${JSON.stringify(p)}`,
			recovered === p,
			`submitted=${JSON.stringify(submitted)} got=${JSON.stringify(recovered)}`,
		);
	}

	// 3) Argumento empty / blank → undefined (el handler muestra el warning "Usage:", nunca switchea).
	check("empty arg → undefined", parseWorkflowCommandArgument("") === undefined);
	check("blank arg → undefined", parseWorkflowCommandArgument("   ") === undefined);

	// 4) Un path absoluto pelado (unquoted) pasa verbatim: el handler acepta un path
	//    tipeado sin JSON quoting, y `[\s\S]*` también mantiene intactos paths pelados multi-word.
	check(
		"bare unquoted path passes through",
		parseWorkflowCommandArgument("/no/quotes.json") === "/no/quotes.json",
		JSON.stringify(parseWorkflowCommandArgument("/no/quotes.json")),
	);
	check(
		"bare unquoted multi-word path passes through",
		parseWorkflowCommandArgument("/My Sessions/a.json") === "/My Sessions/a.json",
		JSON.stringify(parseWorkflowCommandArgument("/My Sessions/a.json")),
	);

	// 5) Un argumento malformed con leading-quote → undefined (rechazado, no half-parsed).
	check(
		"malformed leading-quote arg → undefined",
		parseWorkflowCommandArgument('"unterminated') === undefined,
		JSON.stringify(parseWorkflowCommandArgument('"unterminated')),
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
