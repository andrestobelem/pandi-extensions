import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetSessionCopyDefaults } from "./copy-prefs.js";
import { resetWorktreeWriterGuardSessionDefault } from "./writer-guard.js";

export function registerWorktreeSessionHooks(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		resetSessionCopyDefaults();
		resetWorktreeWriterGuardSessionDefault();
	});
}
