import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
			try {
				const pkg = JSON.parse(readFileSync(file, "utf8"));
				if (!pkg?.name || pkg.private) return null;
				return { dir, relDir: join("extensions", name), file, pkg };
			} catch {
				return null;
			}
		})
		.filter((entry) => entry !== null);
}
