/**
 * `/improve-prompt` — rewrite a rough prompt draft into a clearer, more actionable one
 * before you send it.
 *
 *   /improve-prompt fix the bug in the parser
 *     -> one-shot model call (no tools) rewrites the draft: resolves ambiguity, adds
 *        verifiable success criteria when it helps, keeps your language and intent.
 *     -> shown for review (overlay in the TUI, plain output otherwise).
 *     -> asks (ctx.ui.confirm) whether to SEND it as your next message. Confirm ->
 *        pi.sendUserMessage() injects it as a real user turn (like /plan's approval wake).
 *        Decline -> nothing is sent; the rewrite only stayed on screen.
 *
 * Mirrors pandi-btw's shape (one-shot completeSimple call, no tools, overlay-or-print
 * display) but ADDS the confirm-and-send step, because — unlike a side question — the
 * whole point of an improved prompt is to actually use it.
 *
 * Print/json (no interactive UI): the rewrite is printed and nothing is sent — a one-shot
 * run has no way to ask for confirmation, so sending would be an unreviewed side effect.
 */

import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openAnswerOverlay } from "./answer-overlay.js";
import { buildImproveContext, extractImprovedText } from "./build-improve-context.js";

/** The rewrite should be a clearer prompt, not a long essay. */
const IMPROVE_PROMPT_MAX_TOKENS = 2048;

const STATUS_KEY = "improve-prompt";

/** Notify the user, degrading gracefully outside the TUI (mirrors the sibling extensions). */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode !== "print" && ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "info") console.log(message);
	else console.error(message);
}

function formatImprovePromptFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `improve-prompt failed: ${message}`;
}

function setImprovePromptStatus(ctx: ExtensionCommandContext, value: string | undefined): boolean {
	if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return false;
	ctx.ui.setStatus(STATUS_KEY, value);
	return true;
}

/** Send the improved prompt as the next user turn, idle vs. mid-stream (mirrors /plan's wake). */
function send(pi: ExtensionAPI, ctx: ExtensionCommandContext, improved: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(improved);
	else pi.sendUserMessage(improved, { deliverAs: "followUp" });
}

async function handleImprovePrompt(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const draft = args.trim();
	if (!draft) {
		notify(ctx, "Usage: /improve-prompt <your rough prompt> — rewrites it clearer and offers to send it.", "info");
		return;
	}

	const model = ctx.model;
	if (!model) {
		notify(ctx, "No model selected. Choose one with /model, then retry /improve-prompt.", "error");
		return;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		notify(ctx, `No usable credentials for ${model.provider}/${model.id}: ${auth.error}`, "error");
		return;
	}

	const context = buildImproveContext(draft);

	const options: SimpleStreamOptions = {
		maxTokens: IMPROVE_PROMPT_MAX_TOKENS,
		signal: ctx.signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	// Reasoning only applies to reasoning-capable models; otherwise it is rejected/ignored.
	if (model.reasoning) options.reasoning = pi.getThinkingLevel() as SimpleStreamOptions["reasoning"];

	const showStatus = setImprovePromptStatus(ctx, "improve-prompt: thinking…");

	let response: AssistantMessage;
	try {
		response = await completeSimple(model, context, options);
	} catch (error) {
		notify(ctx, formatImprovePromptFailure(error), "error");
		return;
	} finally {
		if (showStatus) setImprovePromptStatus(ctx, undefined);
	}

	if (response.stopReason === "error") {
		notify(ctx, `improve-prompt failed: ${response.errorMessage ?? "the model returned an error"}`, "error");
		return;
	}
	if (response.stopReason === "aborted") {
		notify(ctx, "improve-prompt cancelled.", "info");
		return;
	}

	const improved = extractImprovedText(response);
	if (!improved) {
		notify(ctx, "improve-prompt: the model returned no rewrite.", "warning");
		return;
	}

	// Print/json: no interactive confirm is possible, so just show the rewrite and stop —
	// sending it unreviewed would be a silent side effect of a one-shot run.
	if (ctx.mode === "print" || !ctx.hasUI) {
		console.log(improved);
		return;
	}

	const body = `**Original**\n\n${draft}\n\n---\n\n**Improved**\n\n${improved}`;
	if (ctx.mode === "tui") {
		await openAnswerOverlay(ctx, "review, then confirm below", body);
	} else {
		// rpc: hasUI but no terminal-only custom() overlay.
		ctx.ui.notify(body, "info");
	}

	const shouldSend = await ctx.ui.confirm("Send improved prompt as your next message?", improved);
	if (!shouldSend) {
		notify(ctx, "Not sent — the improved prompt stayed on screen only.", "info");
		return;
	}
	send(pi, ctx, improved);
}

export default function improvePromptExtension(pi: ExtensionAPI): void {
	pi.registerCommand("improve-prompt", {
		description: "Rewrite a rough prompt draft clearer, then offer to send it as your next message.",
		handler: async (args, ctx) => {
			await handleImprovePrompt(args, ctx, pi);
		},
	});
}
