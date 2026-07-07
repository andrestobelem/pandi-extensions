import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RenderMarkdownToHtml = (markdown: string, options: { title: string; kicker: string; tokensCss: string }) => string;

async function loadMarkdownRenderer(): Promise<RenderMarkdownToHtml> {
	const mod = (await import("@pandi-coding-agent/pandi-docs/scripts/markdown-to-html.mjs")) as {
		renderMarkdownToHtml?: RenderMarkdownToHtml;
	};
	if (typeof mod.renderMarkdownToHtml !== "function") {
		throw new Error("el módulo pandi-docs no exporta renderMarkdownToHtml");
	}
	return mod.renderMarkdownToHtml;
}

export interface PlanHtmlArtifactResult {
	markdownPath: string;
	htmlPath: string;
	opened: boolean;
	openCommand?: string;
	openError?: string;
}

const PLAN_TOKENS_CSS = `
:root {
  --bg:#242526; --paper:#292A2B; --info-bg:#2E2A33; --raised:#31353A;
  --ink:#E6E6E6; --ink2:#BBBBBB; --muted:#757575; --line:#3E4250; --line-strong:#676B79;
  --accent:#FF75B5; --accent-soft:#FF9AC1; --link:#6FC1FF; --info:#45A9F9;
  --success:#19F9D8; --warning:#FFCC95; --error:#FF4B82; --code:#19F9D8; --purple:#BCAAFE;
  --success-bg:#1E2E2B; --error-bg:#2E1E24; --warning-bg:#2E2A33;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#ECECEC; --paper:#F2F1F1; --info-bg:#EDE4F8; --raised:#E6DBCB;
    --ink:#222223; --ink2:#676B79; --muted:#8D8D8D; --line:#C9C9C9; --line-strong:#676B79;
    --accent:#FF0077; --accent-soft:#FF629E; --link:#0091FF; --info:#0091FF;
    --success:#12B69D; --warning:#FF8400; --error:#FF4B82; --code:#12B69D; --purple:#B084EB;
    --success-bg:#DCEEEA; --error-bg:#F7DCE4; --warning-bg:#EDE4F8;
  }
}
`;

const safeSegment = (value: string | undefined, fallback: string): string => {
	const cleaned = String(value ?? "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/^\.+$/, "");
	return cleaned || fallback;
};

const openCommandForPlatform = (platform: NodeJS.Platform, htmlPath: string): { command: string; args: string[] } => {
	if (platform === "darwin") return { command: "open", args: [htmlPath] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", htmlPath] };
	return { command: "xdg-open", args: [htmlPath] };
};

export async function writeAndOpenPlanHtmlArtifact(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	planText: string,
	planId: string,
	submission: number,
	platform: NodeJS.Platform = process.platform,
): Promise<PlanHtmlArtifactResult> {
	const sessionId = safeSegment(ctx.sessionManager?.getSessionId?.(), "session");
	const safePlanId = safeSegment(planId, "plan");
	const dir = path.join(ctx.cwd, ".pi", "plan-artifacts", sessionId);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const baseName = `${stamp}-${safePlanId}-submission-${submission}`;
	const markdownPath = path.join(dir, `${baseName}.md`);
	const htmlPath = path.join(dir, `${baseName}.html`);

	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(markdownPath, planText, "utf8");
	const renderMarkdownToHtml = await loadMarkdownRenderer();
	const html = renderMarkdownToHtml(planText, {
		title: `Plan ${safePlanId}`,
		kicker: "Pandi plan",
		tokensCss: PLAN_TOKENS_CSS,
	});
	fs.writeFileSync(htmlPath, html, "utf8");

	const { command, args } = openCommandForPlatform(platform, htmlPath);
	const opened = await pi
		.exec(command, args, { cwd: ctx.cwd, timeout: 5000 })
		.then((result) => result.code === 0 && !result.killed)
		.catch(() => false);

	return { markdownPath, htmlPath, opened, openCommand: command, ...(opened ? {} : { openError: command }) };
}
