import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "./json-io.mjs";

function isPandiWorkspaceDir(name) {
	return name === "pandi" || name.startsWith("pandi-");
}

/** Workspaces npm publicables bajo extensions/pandi*. */
export function loadPublicWorkspaces(root) {
	const extDir = join(root, "extensions");
	return readdirSync(extDir)
		.filter(isPandiWorkspaceDir)
		.sort()
		.map((name) => {
			const dir = join(extDir, name);
			const file = join(dir, "package.json");
			if (!existsSync(file)) return null;
			const pkg = readJsonFile(file, { onError: "null" });
			if (!pkg?.name || pkg.private) return null;
			return { dir, relDir: join("extensions", name), file, pkg };
		})
		.filter((entry) => entry !== null);
}
