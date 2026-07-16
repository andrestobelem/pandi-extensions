/**
 * Resolución del modelo rápido para session_before_compact.
 */

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { CODEX_FAST_SUMMARY_MODEL, DEFAULT_FAST_SUMMARY_MODEL, FAST_SUMMARY_MODEL_FALLBACKS } from "./fast-summary.js";
import { isCodexModel } from "./settings.js";

type SummaryAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

export interface SummaryModelSelection {
	model: Model<Api>;
	auth: Extract<SummaryAuth, { ok: true }>;
	ref: string;
}

const modelRef = (model: { provider?: string; id?: string } | undefined): string | undefined =>
	model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;

const candidateModelRefs = (preferred: string | undefined, current: ExtensionContext["model"]): string[] => {
	const modelSensitiveDefault = isCodexModel(current) ? CODEX_FAST_SUMMARY_MODEL : DEFAULT_FAST_SUMMARY_MODEL;
	const refs = [preferred || modelSensitiveDefault, ...FAST_SUMMARY_MODEL_FALLBACKS, modelRef(current)].filter(
		(ref): ref is string => typeof ref === "string" && ref.trim().length > 0,
	);
	return [...new Set(refs)];
};

const findModelByRef = (ctx: ExtensionContext, ref: string): Model<Api> | undefined => {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash > 0) return ctx.modelRegistry?.find?.(trimmed.slice(0, slash), trimmed.slice(slash + 1));
	const providers = [ctx.model?.provider, "anthropic", "openai-codex", "ollama"].filter(
		(provider): provider is string => typeof provider === "string" && provider.length > 0,
	);
	for (const provider of [...new Set(providers)]) {
		const model = ctx.modelRegistry?.find?.(provider, trimmed);
		if (model) return model;
	}
	return undefined;
};

export const resolveSummaryModel = async (
	ctx: ExtensionContext,
	preferred: string | undefined,
): Promise<SummaryModelSelection | undefined> => {
	if (!ctx.modelRegistry?.find || !ctx.modelRegistry?.getApiKeyAndHeaders) return undefined;
	for (const ref of candidateModelRefs(preferred, ctx.model)) {
		const model = findModelByRef(ctx, ref);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return { model, auth, ref: modelRef(model) ?? ref };
	}
	return undefined;
};

export const serializeCompactionMessages = (
	messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"],
): string => {
	try {
		return serializeConversation(convertToLlm(messages));
	} catch {
		return JSON.stringify(messages);
	}
};
