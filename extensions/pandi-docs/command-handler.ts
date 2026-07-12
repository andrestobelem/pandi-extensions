import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DOCS_USAGE, tokenizeArgs } from "./args.js";
import { convertMarkdownFile } from "./convert.js";
import { errorMessage } from "./errors.js";
import { notify } from "./notify.js";
import { relativeTo } from "./paths.js";
import { parseArgs } from "./scripts/markdown-to-html.mjs";

export async function handleDocsCommand(args: string, ctx: ExtensionContext): Promise<void> {
	let parsed: {
		inputs?: string[];
		out?: string | null;
		kicker?: string;
		tokens?: string;
		css?: string;
		help?: boolean;
	};
	try {
		parsed = parseArgs(tokenizeArgs(args ?? ""));
	} catch (error) {
		notify(ctx, `${errorMessage(error)}\n${DOCS_USAGE}`, "error");
		return;
	}
	if (parsed.help || !parsed.inputs?.length) {
		notify(ctx, DOCS_USAGE, parsed.help ? "info" : "warning");
		return;
	}
	if (parsed.out && parsed.inputs.length > 1) {
		notify(ctx, `-o solo es válido con un único archivo de entrada\n${DOCS_USAGE}`, "error");
		return;
	}
	const written: string[] = [];
	for (const input of parsed.inputs) {
		try {
			const result = convertMarkdownFile(input, {
				cwd: ctx.cwd,
				out: parsed.out ?? undefined,
				kicker: parsed.kicker,
				tokens: parsed.tokens,
				css: parsed.css,
			});
			written.push(relativeTo(ctx.cwd, result.output));
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
	}
	notify(ctx, `Se escribió ${written.join(", ")}`, "info");
}

export function registerDocsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("docs", {
		description: "Convertí un archivo Markdown a HTML autocontenido con estilo pandi",
		handler: async (args, ctx) => await handleDocsCommand(args, ctx),
	});
}
