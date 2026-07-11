import { existsSync, readdirSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composeInjectedMemory, INDEX_FILE } from "./memory.js";
import { indexPathOf, legacyPathOf, memoryDirOf, safeRead } from "./paths.js";

export function injectLocalMemory(event: { systemPrompt: string }, ctx: ExtensionContext) {
	const memoryDir = memoryDirOf(ctx.cwd);
	const indexPath = indexPathOf(ctx.cwd);
	const legacyPath = legacyPathOf(ctx.cwd);

	let indexText = safeRead(indexPath);
	let usingLegacy = false;
	let shownPath = indexPath;
	if (indexText === null) {
		indexText = safeRead(legacyPath);
		usingLegacy = true;
		shownPath = legacyPath;
	}
	if (indexText === null) return;
	const trimmed = indexText.trim();
	if (!trimmed) return;

	let topicNames: string[] = [];
	if (!usingLegacy) {
		try {
			if (existsSync(memoryDir)) {
				topicNames = readdirSync(memoryDir)
					.filter((name) => name.endsWith(".md") && name !== INDEX_FILE)
					.sort();
			}
		} catch {
			topicNames = [];
		}
	}

	const body = composeInjectedMemory({
		indexText: trimmed,
		topicNames,
		memoryDirPath: memoryDir,
	});
	return {
		systemPrompt: `${event.systemPrompt}\n\n<local_memory path="${shownPath}">\n${body}\n</local_memory>`,
	};
}
