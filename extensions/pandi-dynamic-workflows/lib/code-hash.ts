/**
 * Hashing de código de workflow para drift detection y journaling.
 *
 * Función pura: dado el mismo código fuente, produce el mismo hash SHA-256.
 * Vive en lib/ porque no depende de estado de corrida ni de runtime.
 */
import * as crypto from "node:crypto";
import { transformWorkflowCode } from "./transform.js";

export function computeCodeHash(code: string): string {
	return crypto.createHash("sha256").update(transformWorkflowCode(code)).digest("hex");
}
