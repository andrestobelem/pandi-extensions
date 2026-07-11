/**
 * pandi-personas — registra personas advisor empaquetadas para pandi-dynamic-workflows.
 */

import { registerPersonaDirectory } from "./personas-registry.js";

export { registerPersonaDirectory } from "./personas-registry.js";

export default function pandiPersonasExtension(): void {
	registerPersonaDirectory();
}
