// Hand-written types for the sibling md-to-html.mjs (the converter stays a plain .mjs so
// repo scripts and the CLI can run it with plain node; tsconfig has no allowJs, so the
// TypeScript entry imports it through this declaration).

export interface RenderOptions {
	/** Pandi tokens CSS to embed; default: read from the vendored skill copy. */
	tokensCss?: string;
	/** Kicker line above the title (default "Pandi artifact"). */
	kicker?: string;
	/** Fallback page title when the document has no leading `# h1`. */
	title?: string;
}

export function renderMarkdownToHtml(md: string, opts?: RenderOptions): string;

export interface ParsedArgs {
	inputs?: string[];
	out?: string | null;
	kicker?: string;
	help?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs;
