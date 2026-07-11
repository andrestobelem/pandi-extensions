/**
 * pandi-podman: superficie reducida de Podman para Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPodmanCommand } from "./command-handler.js";
import { registerPodmanSandboxTool } from "./tool-handler.js";

export * from "./public-api.js";

export default function podmanExtension(pi: ExtensionAPI): void {
	registerPodmanCommand(pi);
	registerPodmanSandboxTool(pi);
}
