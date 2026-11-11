import streamDeck from "@elgato/streamdeck";

import { TapoAuthError, TapoClient } from "./tapo/klap";

/**
 * Plugin-wide settings (shared by every key, edited from any key's Property Inspector).
 * Safe mode is global on purpose: it protects the plug itself, so a "Turn Off" key must not be able
 * to bypass the lock started by a "Turn On" or "Toggle" key.
 */
export type GlobalSettings = {
	host?: string;
	username?: string;
	password?: string;
	safeMode?: boolean;
	/** Lock duration in seconds (text field in the PI, so it may arrive as a string). */
	cooldownSeconds?: string | number;
};

export type Command = "toggle" | "on" | "off";

export type PressResult = "switched" | "unchanged" | "locked" | "busy" | "not-configured" | "error";

export type PlugView = {
	/** Current plug state; undefined when not known yet. */
	on: boolean | undefined;
	error: string | undefined;
	busy: boolean;
	/** Remaining lock time in whole seconds (0 when not locked). */
	lockRemaining: number;
	/** Fraction of the lock still remaining, 1 → 0. */
	lockFraction: number;
	configured: boolean;
};

export const DEFAULT_COOLDOWN_SECONDS = 10;
const POLL_INTERVAL_MS = 5000;
const MAX_COOLDOWN_SECONDS = 3600;

class PlugController {
	private settings: GlobalSettings = {};
	private client: TapoClient | undefined;
	private on: boolean | undefined;
	private error: string | undefined;
	private busy = false;
	/** Time (ms) of the last known switch, whether from a key press or detected externally. */
	private lastSwitchAt = 0;
	private visibleKeys = new Set<string>();
	private pollTimer: NodeJS.Timeout | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private listeners = new Set<() => void>();

	onChange(listener: () => void): void {
		this.listeners.add(listener);
	}

	applySettings(settings: GlobalSettings): void {
		const prev = this.settings;
		this.settings = settings;
		const connectionChanged =
			prev.host !== settings.host || prev.username !== settings.username || prev.password !== settings.password;
		if (connectionChanged) {
			this.client = this.isConfigured()
				? new TapoClient(settings.host!.trim(), settings.username!.trim(), settings.password!)
				: undefined;
			this.on = undefined;
			this.error = undefined;
			void this.poll();
		}
		this.scheduleTick();
		this.emit();
	}

	keyAppeared(id: string): void {
		this.visibleKeys.add(id);
		if (!this.pollTimer) {
			this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
			void this.poll();
		}
	}

	keyDisappeared(id: string): void {
		this.visibleKeys.delete(id);
		if (this.visibleKeys.size === 0 && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	get view(): PlugView {
		const total = this.cooldownMs();
		const remainingMs = this.lockRemainingMs();
		return {
			on: this.on,
			error: this.error,
			busy: this.busy,
			lockRemaining: Math.ceil(remainingMs / 1000),
			lockFraction: total > 0 ? remainingMs / total : 0,
			configured: this.isConfigured(),
		};
	}

	async press(command: Command): Promise<PressResult> {
		if (!this.client) return "not-configured";
		// While the safe-mode lock is running, presses are ignored on every key.
		if (this.lockRemainingMs() > 0) return "locked";
		if (this.busy) return "busy";

		const client = this.client;
		this.busy = true;
		this.emit();
		let lockStartedHere = false;
		try {
			// Always read the real state first so Toggle acts on the truth, not on a stale poll.
			const info = await client.getDeviceInfo();
			this.setKnownState(info.device_on, info.on_time);
			const target = command === "toggle" ? !info.device_on : command === "on";
			if (target === info.device_on) return "unchanged";

			// Start the lock *before* sending: if the response gets lost the plug may still have switched.
			this.lastSwitchAt = Date.now();
			lockStartedHere = true;
			await client.setOn(target);
			this.on = target;
			this.error = undefined;
			streamDeck.logger.info(`Plug switched ${target ? "ON" : "OFF"} by key (${command}).`);
			return "switched";
		} catch (err) {
			this.error = describe(err);
			streamDeck.logger.error(`Press (${command}) failed: ${this.error}`);
			if (lockStartedHere) await this.verifyAfterFailure(client);
			return "error";
		} finally {
			this.busy = false;
			this.scheduleTick();
			this.emit();
		}
	}

	/** After a failed switch, drop the lock only if we can confirm the plug did not change. */
	private async verifyAfterFailure(client: TapoClient): Promise<void> {
		const before = this.on;
		try {
			const info = await client.getDeviceInfo();
			if (info.device_on === before) {
				this.lastSwitchAt = 0;
			} else {
				this.on = info.device_on;
			}
		} catch {
			// Unknown outcome: keep the lock (safety first).
		}
	}

	private async poll(): Promise<void> {
		const client = this.client;
		if (!client || this.polling || this.busy) return;
		this.polling = true;
		try {
			const info = await client.getDeviceInfo();
			if (client !== this.client || this.busy) return;
			this.setKnownState(info.device_on, info.on_time);
			this.error = undefined;
		} catch (err) {
			if (client !== this.client) return;
			this.error = describe(err);
			if (err instanceof TapoAuthError) this.on = undefined;
		} finally {
			this.polling = false;
			this.scheduleTick();
			this.emit();
		}
	}

	/**
	 * Records the state read from the plug. If it changed without us (Tapo app, physical button), the lock
	 * is started too, so the deck cannot flip it straight back. For "on" the plug's own on_time is used,
	 * which also covers a plug that was switched on shortly before Stream Deck started.
	 */
	private setKnownState(on: boolean, onTimeSec: number | undefined): void {
		const now = Date.now();
		if (on && typeof onTimeSec === "number") {
			// The plug reports how long it has been on: use it, so the lock survives a Stream Deck restart.
			const switchedAt = now - onTimeSec * 1000;
			if (switchedAt > this.lastSwitchAt) this.lastSwitchAt = switchedAt;
		} else if (this.on !== undefined && this.on !== on) {
			this.lastSwitchAt = Math.max(this.lastSwitchAt, now);
		}
		this.on = on;
	}

	private isConfigured(): boolean {
		const s = this.settings;
		return !!(s.host?.trim() && s.username?.trim() && s.password);
	}

	private cooldownMs(): number {
		// Safe mode is ON unless explicitly unticked (protects the speakers out of the box).
		if (this.settings.safeMode === false) return 0;
		const raw = Number(this.settings.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS);
		const sec = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_COOLDOWN_SECONDS) : DEFAULT_COOLDOWN_SECONDS;
		return sec * 1000;
	}

	private lockRemainingMs(): number {
		const total = this.cooldownMs();
		if (total === 0 || this.lastSwitchAt === 0) return 0;
		return Math.max(0, this.lastSwitchAt + total - Date.now());
	}

	/** Re-renders keys once per second while the lock is running so the countdown updates. */
	private scheduleTick(): void {
		if (this.tickTimer) return;
		const remaining = this.lockRemainingMs();
		if (remaining <= 0) return;
		const delay = remaining % 1000 || 1000;
		this.tickTimer = setTimeout(() => {
			this.tickTimer = undefined;
			this.emit();
			this.scheduleTick();
		}, delay + 5);
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

function describe(err: unknown): string {
	if (err instanceof TapoAuthError) return err.message;
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") return "Plug not responding (check IP)";
		const code = (err as { code?: string }).code;
		if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ECONNREFUSED") {
			return `Plug unreachable (${code}) - check IP`;
		}
		if (code) return `Network error: ${code}`;
		return err.message;
	}
	return String(err);
}

export const plug = new PlugController();
