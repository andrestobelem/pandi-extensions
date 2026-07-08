import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { PandiSessionModel } from "./session-registry.js";

interface DashboardTheme {
	bold?: (value: string) => string;
}

export type PandiSessionDashboardResult =
	| { type: "switchSession"; session: PandiSessionModel }
	| { type: "cleanup" }
	| null;

function clip(text: string | undefined, max: number): string {
	const value = (text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
}

function sessionLabel(session: PandiSessionModel): string {
	return session.sessionName ?? session.sessionId ?? session.id;
}

function statusLabel(session: PandiSessionModel): string {
	if (session.live) return session.current ? "current" : "live";
	return `stale:${session.staleReason ?? "desconocido"}`;
}

function limitSelectedIndex(selected: number, sessionCount: number): number {
	return Math.min(selected, Math.max(0, sessionCount - 1));
}

export class PandiSessionDashboard {
	private sessions: PandiSessionModel[];
	private selected = 0;
	private refreshError: string | undefined;

	constructor(
		sessions: PandiSessionModel[],
		private readonly theme: DashboardTheme,
		private readonly requestRender: () => void,
		private readonly done: (result: PandiSessionDashboardResult) => void,
	) {
		this.sessions = sessions;
	}

	private styledHeader(text: string): string {
		return this.theme.bold?.(text) ?? text;
	}

	setSessions(next: PandiSessionModel[]): void {
		const previous = this.sessions[this.selected];
		this.sessions = next;
		if (previous) {
			const found = next.findIndex((session) => session.id === previous.id);
			this.selected = found >= 0 ? found : limitSelectedIndex(this.selected, next.length);
		} else {
			this.selected = limitSelectedIndex(this.selected, next.length);
		}
	}

	markRefreshOk(): void {
		this.refreshError = undefined;
	}

	markRefreshError(message: string): void {
		this.refreshError = message;
	}

	invalidate(): void {
		/* el estado renderizado se deriva de las sesiones y del índice seleccionado */
	}

	handleInput(data: string): void {
		if (data === "q" || data === "escape" || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (data === "C" || data === "c") {
			this.done({ type: "cleanup" });
			return;
		}
		if (data === "enter" || matchesKey(data, Key.enter)) {
			const session = this.sessions[this.selected];
			if (session) this.done({ type: "switchSession", session });
			return;
		}
		if (data === "down" || data === "j" || matchesKey(data, Key.down)) {
			this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
			this.requestRender();
			return;
		}
		if (data === "up" || data === "k" || matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
		}
	}

	render(width = 100): string[] {
		const safeWidth = Math.max(60, width);
		const live = this.sessions.filter((session) => session.live).length;
		const stale = this.sessions.length - live;
		const current = this.sessions.filter((session) => session.current).length;
		const lines: string[] = [
			this.styledHeader(
				`Sesiones Pandi · total:${this.sessions.length} live:${live} stale:${stale} current:${current}`,
			),
			"",
		];
		if (this.refreshError) lines.push(`advertencia de actualización: ${clip(this.refreshError, safeWidth - 28)}`, "");
		if (this.sessions.length === 0) {
			lines.push("No hay sesiones Pandi registradas para este proyecto.");
			return lines;
		}
		for (const [index, session] of this.sessions.entries()) {
			const cursor = index === this.selected ? "›" : " ";
			const currentMark = session.current ? "★" : " ";
			const row = `${cursor} ${currentMark} ${pad(statusLabel(session), 18)} ${pad(clip(sessionLabel(session), 28), 28)} ${clip(session.cwd, safeWidth - 54)}`;
			lines.push(row);
		}
		const selected = this.sessions[this.selected];
		if (selected) {
			lines.push(
				"",
				this.styledHeader("Sesión Pandi seleccionada"),
				`id: ${selected.id}`,
				`sesión: ${selected.sessionId ?? "(desconocida)"}`,
				`archivo: ${selected.sessionFile ?? selected.file}`,
				`cwd: ${selected.cwd}`,
				`actualizado: ${selected.updatedAt}`,
				`estado: ${statusLabel(selected)}`,
				"",
				"↑/↓ j/k seleccionar · Enter/→ cambiar · C limpiar obsoletas · q cerrar",
			);
		}
		return lines.map((line) => line.slice(0, safeWidth));
	}
}
