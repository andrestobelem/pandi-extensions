import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { normalizeNote, upsertMemoryNote } from "./memory.js";

const MEMORY_FILE = "MEMORY.md";

export default function localMemoryExtension(pi: ExtensionAPI): void {
	// Model-callable WRITE path: lets Pi persist a durable note to .pi/MEMORY.md on its own
	// initiative (the read/inject hook below feeds it back into future sessions). Appends only
	// to a managed block so human-curated content is never touched; idempotent; fails safe.
	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Persist a short, durable note to this project's local memory (.pi/MEMORY.md) so it is available to you in future sessions. Use for stable user preferences, project conventions, and key decisions — not for ephemeral details or secrets. Appends to a managed section without touching human-curated notes; saving the same note twice is a no-op.",
		promptSnippet: "Persist a durable note to project memory (.pi/MEMORY.md) for future sessions.",
		promptGuidelines: [
			"Use remember to persist DURABLE, reusable facts across sessions: stable user preferences, project conventions, key decisions, or hard-won gotchas — things a future session should not have to re-discover.",
			"Do NOT use remember for ephemeral or one-off details, secrets/credentials/tokens, large content, or anything already captured in the repo, docs, or this conversation; keep each note to one or two concise sentences.",
			"remember appends to a managed section of .pi/MEMORY.md that is injected into your context in later sessions, and it is idempotent (re-saving the same note is a no-op), so prefer one clear note over many near-duplicates.",
		],
		parameters: Type.Object({
			note: Type.String({
				minLength: 1,
				description: "A concise, durable fact to remember for future sessions (one or two sentences).",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const note = normalizeNote(params.note);
			if (!note) {
				return {
					content: [{ type: "text" as const, text: "Nothing to remember: the note was empty after trimming." }],
					details: { isError: true, remembered: false },
				};
			}
			const memoryPath = join(ctx.cwd, ".pi", MEMORY_FILE);
			// Read the existing file (if any). A read failure (EISDIR/EACCES/TOCTOU) is a HARD stop —
			// never clobber a file we could not read.
			let existing = "";
			try {
				if (existsSync(memoryPath)) existing = readFileSync(memoryPath, "utf8");
			} catch {
				return {
					content: [
						{ type: "text" as const, text: `Could not read existing memory at ${memoryPath}; nothing was written.` },
					],
					details: { isError: true, remembered: false, path: memoryPath },
				};
			}
			const date = new Date().toISOString().slice(0, 10);
			const { content, added } = upsertMemoryNote(existing, note, date);
			if (!added) {
				return {
					content: [{ type: "text" as const, text: `Already in memory (no-op): "${note}"` }],
					details: { remembered: false, duplicate: true, path: memoryPath },
				};
			}
			try {
				mkdirSync(dirname(memoryPath), { recursive: true });
				writeFileSync(memoryPath, content, "utf8");
			} catch (err) {
				return {
					content: [
						{ type: "text" as const, text: `Failed to write memory at ${memoryPath}: ${(err as Error).message}` },
					],
					details: { isError: true, remembered: false, path: memoryPath },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Remembered (saved to .pi/MEMORY.md): "${note}"` }],
				details: { remembered: true, path: memoryPath },
			};
		},
	});

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
