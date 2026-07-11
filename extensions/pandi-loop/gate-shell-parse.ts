/**
 * Parsing shell best-effort para el gate destructivo autopilot de pandi-loop.
 */

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>>?\|?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
export const AMP_REDIRECT_TARGET_RE = /(?:^|[\s;|&(])&>>?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
export const GT_AMP_REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>&\s*(?![-\d&])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
export const TEE_ARGS_RE = /\btee\b((?:\s+(?:-\S+|"[^"]*"|'[^']*'|[^\s|&;<>]+))+)/gi;
export const CD_TARGET_RE = /(?:^|[;&|\n(])[ \t]*(?:cd|pushd)\b[ \t]*("[^"]*"|'[^']*'|[^\s|&;<>]+)?/gi;

export function commandChangesToUnsafeDir(ctx: ExtensionContext, command: string): boolean {
	for (const m of command.matchAll(CD_TARGET_RE)) {
		const raw = m[1];
		if (raw === undefined) return true;
		const dir = unquote(raw);
		if (dir === "" || dir === "-") return true;
		if (isUnsafeWritePath(ctx, dir)) return true;
	}
	return false;
}

export function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function collectBashWriteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const re of [REDIRECT_TARGET_RE, AMP_REDIRECT_TARGET_RE, GT_AMP_REDIRECT_TARGET_RE]) {
		for (const m of command.matchAll(re)) if (m[1]) targets.push(unquote(m[1]));
	}
	for (const m of command.matchAll(TEE_ARGS_RE)) {
		if (!m[1]) continue;
		for (const tok of m[1].trim().split(/\s+/)) {
			if (tok.startsWith("-")) continue;
			targets.push(unquote(tok));
		}
	}
	return targets;
}

export function unsafeBashWriteTarget(ctx: ExtensionContext, command: string): string | undefined {
	const targets = collectBashWriteTargets(command);
	const leftProject = commandChangesToUnsafeDir(ctx, command);
	for (const target of targets) {
		if (target.startsWith("/dev/")) continue;
		if (isUnsafeWritePath(ctx, target)) return target;
		if (leftProject && !path.isAbsolute(target)) return target;
	}
	return undefined;
}

export function isUnsafeWritePath(ctx: ExtensionContext, filePath: unknown): boolean {
	if (typeof filePath !== "string" || filePath.length === 0) return false;
	const p = filePath.replace(/\\(.)/g, "$1");
	if (p.startsWith("~")) return true;
	if (/\$[\w{(]/.test(p)) return true;
	if (p.includes("`")) return true;
	const normalized = path.normalize(p);
	if (normalized.split(path.sep).includes("..")) return true;
	if (path.isAbsolute(normalized)) {
		const root = path.resolve(ctx.cwd);
		const target = path.resolve(normalized);
		return target !== root && !target.startsWith(root + path.sep);
	}
	return false;
}
