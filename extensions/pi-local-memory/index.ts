import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MEMORY_FILE = "MEMORY.md";

export default function localMemoryExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const memoryPath = join(ctx.cwd, ".pi", MEMORY_FILE);
		if (!existsSync(memoryPath)) return;

		// existsSync only proves an entry exists, not that it is a readable regular
		// file. A directory (EISDIR), permission error (EACCES), or TOCTOU removal would
		// otherwise throw inside the hook; degrade to the same silent skip as "absent".
		let memory: string;
		try {
			memory = readFileSync(memoryPath, "utf8").trim();
		} catch {
			return;
		}
		if (!memory) return;

		// Neutralize any literal local_memory tag in the content so it cannot close the
		// fence early and inject text at the trusted prompt's structural level.
		const safe = memory.replace(/<\/?local_memory/gi, (match) => match.replace("<", "&lt;"));

		return {
			systemPrompt: `${event.systemPrompt}\n\n<local_memory path="${memoryPath}">\n${safe}\n</local_memory>`,
		};
	});
}
