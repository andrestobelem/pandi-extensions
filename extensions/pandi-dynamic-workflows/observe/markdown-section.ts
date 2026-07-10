/**
 * Extracción de secciones Markdown por heading — copia local para observe.
 * Evita importar el deep module tui (regla OBS ↛ TUI). Misma semántica que tui/agent-view-format.
 */
export function extractMarkdownSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const knownHeadings = ["Access", "Prompt", "Structured Output", "Stdout", "Stderr"];
	const nextHeadings = knownHeadings
		.filter((candidate) => candidate !== heading)
		.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const nextPattern = nextHeadings.length ? `\\n## (?:${nextHeadings.join("|")})\\n` : "$^";
	const match = new RegExp(`(?:^|\\n)## ${escaped}\\n\\n([\\s\\S]*?)(?=${nextPattern}|$)`).exec(markdown);
	return match?.[1]?.trim();
}
