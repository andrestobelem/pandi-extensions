import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MEMORY_FILE = "MEMORY.md";

export default function localMemoryExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const memoryPath = join(ctx.cwd, ".pi", MEMORY_FILE);
		if (!existsSync(memoryPath)) return;

		const memory = readFileSync(memoryPath, "utf8").trim();
		if (!memory) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n<local_memory path="${memoryPath}">\n${memory}\n</local_memory>`,
		};
	});
}
