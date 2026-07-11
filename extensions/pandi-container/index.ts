/**
 * pandi-container: administra sandboxes de Apple `container` (micro-VMs Linux) desde Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContainerCommand } from "./command-handler.js";
import { registerContainerSandboxTool } from "./tool-handler.js";

export * from "./public-api.js";

export default function containerExtension(pi: ExtensionAPI): void {
	registerContainerCommand(pi);
	registerContainerSandboxTool(pi);
}
