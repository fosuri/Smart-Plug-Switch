import streamDeck from "@elgato/streamdeck";

/**
 * Stream Deck asks plugins to keep programmatic calls (setImage etc.) to at most 10 per second.
 * All key images go through this queue: calls are spaced out (~8/s max, shared by every key and action),
 * and a newer image for the same key replaces an older one that has not been sent yet.
 */
/** The part of a key action the queue needs. */
type ImageTarget = { id: string; setImage(image?: string): Promise<void> };

const MIN_INTERVAL_MS = 125;

const pending = new Map<string, { action: ImageTarget; image: string }>();
let timer: NodeJS.Timeout | undefined;
let lastSentAt = 0;

export function queueImage(action: ImageTarget, image: string): void {
	pending.set(action.id, { action, image });
	schedule();
}

export function dropImage(actionId: string): void {
	pending.delete(actionId);
}

function schedule(): void {
	if (timer || pending.size === 0) return;
	const wait = Math.max(0, lastSentAt + MIN_INTERVAL_MS - Date.now());
	timer = setTimeout(() => {
		timer = undefined;
		const next = pending.entries().next();
		if (!next.done) {
			const [id, { action, image }] = next.value;
			pending.delete(id);
			lastSentAt = Date.now();
			action.setImage(image).catch((err: unknown) => streamDeck.logger.warn(`setImage failed: ${err}`));
		}
		schedule();
	}, wait);
}
