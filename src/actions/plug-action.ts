import {
	action,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { dropImage, queueImage } from "../image-queue";
import { type Command, plug } from "../plug-controller";
import { renderKey } from "../render";

/** Shared behaviour for Toggle / Turn On / Turn Off keys; they differ only in the command they send. */
abstract class PlugAction extends SingletonAction {
	protected abstract readonly command: Command;
	private lastImage = new Map<string, string>();

	constructor() {
		super();
		plug.onChange(() => this.renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.lastImage.delete(ev.action.id);
		plug.keyAppeared(ev.action.id);
		this.renderAll();
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.lastImage.delete(ev.action.id);
		dropImage(ev.action.id);
		plug.keyDisappeared(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const result = await plug.press(this.command, ev.action.id);
		// "locked", "busy" and "armed" need no alert: the key itself shows the countdown.
		if (result === "error" || result === "not-configured") await ev.action.showAlert();
	}

	private renderAll(): void {
		const view = plug.view;
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			const image = renderKey(this.command, view, a.id);
			if (this.lastImage.get(a.id) === image) continue;
			this.lastImage.set(a.id, image);
			queueImage(a, image);
		}
	}
}

@action({ UUID: "com.fosuri.smart-plug-switch.toggle" })
export class TogglePlug extends PlugAction {
	protected readonly command = "toggle";
}

@action({ UUID: "com.fosuri.smart-plug-switch.on" })
export class TurnOnPlug extends PlugAction {
	protected readonly command = "on";
}

@action({ UUID: "com.fosuri.smart-plug-switch.off" })
export class TurnOffPlug extends PlugAction {
	protected readonly command = "off";
}
