import type { FaceStyle } from "./face.js";
import { loadFaceStyle } from "./face-style-storage.js";

export type PandiRuntime = {
	enabled: boolean;
	artVisible: boolean;
	faceStyle: FaceStyle;
};

export function createPandiRuntime(): PandiRuntime {
	return {
		enabled: true,
		artVisible: true,
		faceStyle: loadFaceStyle(),
	};
}
