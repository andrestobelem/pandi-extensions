/**
 * Router del slash command `/bg` — delega a handlers por grupo de subcomando.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleDelete, handlePrune } from "./command-cleanup.js";
import { handleCancel, handlePreview, handleStart } from "./command-lifecycle.js";
import { handleEvents, handleList, handleLogs, handleStatus } from "./command-query.js";
import { BG_ARGUMENT_COMPLETIONS, type BgResponse, canRunInMode, notifyBg, response } from "./command-shared.js";

export type { BgResponse };
export { BG_ARGUMENT_COMPLETIONS, canRunInMode, notifyBg };

export async function handleBgCommand(args: string, ctx: ExtensionContext): Promise<BgResponse> {
	try {
		const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trimStart());
		if (!match) {
			return response(
				"Uso: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId> | /bg delete <jobId> | /bg prune [--yes]",
				undefined,
				"warning",
			);
		}
		const subcommand = match[1] ?? "";
		const tail = match[2] ?? "";
		switch (subcommand.toLowerCase()) {
			case "preview":
			case "plan": // alias deprecated de preview
				return await handlePreview(tail);
			case "start":
				return await handleStart(ctx, tail);
			case "cancel":
				return await handleCancel(ctx, tail.trim());
			case "list":
				return await handleList(ctx);
			case "status":
				return await handleStatus(ctx, tail.trim());
			case "logs":
				return await handleLogs(ctx, tail.trim());
			case "events":
				return await handleEvents(ctx, tail.trim());
			case "delete":
				return await handleDelete(ctx, tail.trim());
			case "prune":
				return await handlePrune(ctx, tail);
			default:
				return response(
					`Subcomando /bg desconocido: ${subcommand}. Soportados: preview, start, cancel, list, status, logs, events, delete, prune.`,
					undefined,
					"warning",
				);
		}
	} catch (err) {
		return response(`/bg falló: ${(err as Error).message}`, { error: (err as Error).message }, "error");
	}
}
