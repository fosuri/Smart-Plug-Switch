import type { Command, PlugView } from "./plug-controller";

const SIZE = 144;
const COLORS = {
	bg: "#16181c",
	on: "#3ddc84",
	off: "#6b7280",
	unknown: "#4b5563",
	error: "#ef4444",
	lock: "#f59e0b",
	confirm: "#38bdf8",
	text: "#e5e7eb",
	dim: "#9ca3af",
};

const CAPTION: Record<Command, string> = {
	toggle: "",
	on: "TURN ON",
	off: "TURN OFF",
};

/** Builds the key image as an SVG data URL. */
export function renderKey(command: Command, view: PlugView, keyId: string): string {
	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${COLORS.bg}"/>`];

	const stateText = !view.configured
		? "SETUP"
		: view.error && view.on === undefined
			? "ERROR"
			: view.on === undefined
				? "..."
				: view.on
					? "ON"
					: "OFF";
	const stateColor = !view.configured
		? COLORS.dim
		: view.error
			? COLORS.error
			: view.on === undefined
				? COLORS.unknown
				: view.on
					? COLORS.on
					: COLORS.off;

	const confirming = view.armedKey === keyId && view.lockRemaining === 0;
	if (confirming) {
		parts.push(ring(view.armedFraction, COLORS.confirm));
		parts.push(text(72, 86, String(view.armedRemaining), 46, COLORS.text, 700));
	} else if (view.lockRemaining > 0) {
		parts.push(ring(view.lockFraction, COLORS.lock));
		parts.push(
			text(72, view.lockRemaining >= 100 ? 82 : 86, String(view.lockRemaining), view.lockRemaining >= 100 ? 38 : 46, COLORS.text, 700),
		);
	} else {
		parts.push(powerIcon(stateColor, view.busy));
	}

	const caption = CAPTION[command];
	if (caption) parts.push(text(72, 24, caption, 17, COLORS.dim, 600));
	if (confirming) parts.push(text(72, 132, "PRESS AGAIN", 18, COLORS.confirm, 700));
	else parts.push(text(72, 132, stateText, 20, stateColor, 700));

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${parts.join("")}</svg>`;
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function powerIcon(color: string, busy: boolean): string {
	const opacity = busy ? 0.45 : 1;
	// Arc of a circle open at the top, plus the vertical bar.
	return (
		`<g stroke="${color}" stroke-width="9" stroke-linecap="round" fill="none" opacity="${opacity}">` +
		`<path d="M 51.8 49.5 A 30 30 0 1 0 92.2 49.5"/>` +
		`<line x1="72" y1="34" x2="72" y2="68"/>` +
		`</g>`
	);
}

function ring(fraction: number, color: string): string {
	const r = 38;
	const cx = 72;
	const cy = 72;
	const circumference = 2 * Math.PI * r;
	const dash = Math.max(0, Math.min(1, fraction)) * circumference;
	return (
		`<circle cx="${cx}" cy="${cy}" r="${r}" stroke="#2a2e35" stroke-width="8" fill="none"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${color}" stroke-width="8" fill="none" stroke-linecap="round" ` +
		`stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${r - 10}" fill="${color}" opacity="0.12"/>`
	);
}

function text(x: number, y: number, value: string, size: number, color: string, weight: number): string {
	return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escape(value)}</text>`;
}

function escape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
