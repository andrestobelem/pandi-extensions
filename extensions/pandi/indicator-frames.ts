import type { Theme, ThemeColor, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { FACE_EYE_ROLE, type FaceStyle, glintEye } from "./face.js";

const FACE_FAMILY_ANIMATION_LOOPS = 3;

function repeatFrames(frames: string[], loops: number): string[] {
	const repeated: string[] = [];
	for (let i = 0; i < loops; i++) repeated.push(...frames);
	return repeated;
}

function dots(theme: Theme, n: number): string {
	return n > 0 ? theme.fg("dim", ` ${".".repeat(n)}`) : "";
}

/** Caritas kaomoji con ojos coloreados desde la paleta del tema. */
export function pandaFaces(theme: Theme) {
	const kao = (role: keyof typeof FACE_EYE_ROLE, left: string, right: string): string => {
		const fg = theme.getFgAnsi(FACE_EYE_ROLE[role]);
		return `ʕ ${glintEye(left, fg)}ᴥ${glintEye(right, fg)} ʔ`;
	};
	const gatunoFg = theme.getFgAnsi(FACE_EYE_ROLE.gatuno);
	return {
		basico: kao("basico", "•", "•"),
		thinking: kao("thinking", "•̀", "•́"),
		happy: kao("happy", "◕", "◕"),
		error: kao("error", "╥", "╥"),
		gatuno: `(=${glintEye("◕", gatunoFg)}ᴥ${glintEye("◕", gatunoFg)}=)`,
	};
}

function framesClaude(theme: Theme): WorkingIndicatorOptions {
	const eye = (c: string) => (c === "◆" ? theme.fg("accent", "◆") : c);
	const face = (l: string, r: string) => `${theme.fg("dim", "(")}${eye(l)}  ${eye(r)}${theme.fg("dim", ")")}`;
	const bearEye = (c: string) => glintEye(c, theme.getFgAnsi("accent"));
	const bear = (l: string, r: string) =>
		`${theme.fg("dim", "ʕ ")}${bearEye(l)}${theme.fg("dim", "ᴥ")}${bearEye(r)}${theme.fg("dim", " ʔ")}`;
	const classicFrames = [
		face("●", "●") + dots(theme, 0),
		face("●", "●") + dots(theme, 1),
		face("◆", "●") + dots(theme, 2),
		face("●", "◆") + dots(theme, 3),
		face("◆", "◆") + dots(theme, 2),
		face("-", "-") + dots(theme, 1),
	];
	const bearFrames = [
		bear("•", "•") + dots(theme, 0),
		bear("•", "•") + dots(theme, 1),
		bear("•", "•") + dots(theme, 2),
		bear("-", "-") + dots(theme, 3),
		bear("·", "·") + dots(theme, 2),
		bear("^", "^") + dots(theme, 1),
	];
	return {
		frames: [
			...repeatFrames(classicFrames, FACE_FAMILY_ANIMATION_LOOPS),
			...repeatFrames(bearFrames, FACE_FAMILY_ANIMATION_LOOPS),
		],
		intervalMs: 180,
	};
}

function framesKaomoji(
	theme: Theme,
	spec: { l: string; r: string; eyeL: string; eyeR: string; role: ThemeColor },
): WorkingIndicatorOptions {
	const fg = theme.getFgAnsi(spec.role);
	const face = (a: string, b: string) =>
		`${theme.fg("accent", spec.l)}${glintEye(a, fg)}${theme.fg("accent", "ᴥ")}${glintEye(b, fg)}${theme.fg("accent", spec.r)}`;
	const { eyeL, eyeR } = spec;
	return {
		frames: [
			face(eyeL, eyeR) + dots(theme, 0),
			face(eyeL, eyeR) + dots(theme, 1),
			face(eyeL, eyeR) + dots(theme, 2),
			face(eyeL, eyeR) + dots(theme, 3),
			face("-", "-") + dots(theme, 3),
			face("·", "·") + dots(theme, 2),
			face(eyeL, eyeR) + dots(theme, 1),
			face("^", "^") + dots(theme, 0),
		],
		intervalMs: 180,
	};
}

const KAOMOJI_STYLE_SPECS = {
	kaomoji: { l: "ʕ ", r: " ʔ", eyeL: "•", eyeR: "•", role: "accent" },
	ojitos: { l: "ʕ ", r: " ʔ", eyeL: "◕", eyeR: "◕", role: "success" },
	decidido: { l: "ʕ ", r: " ʔ", eyeL: "•̀", eyeR: "•́", role: "accent" },
	gatuno: { l: "(=", r: "=)", eyeL: "◕", eyeR: "◕", role: "accent" },
} satisfies Record<
	Exclude<FaceStyle, "claude">,
	{ l: string; r: string; eyeL: string; eyeR: string; role: ThemeColor }
>;

export function pandaFrames(theme: Theme, style: FaceStyle): WorkingIndicatorOptions {
	if (style === "claude") return framesClaude(theme);
	return framesKaomoji(theme, KAOMOJI_STYLE_SPECS[style]);
}
