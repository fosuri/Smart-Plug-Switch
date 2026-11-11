import {
	action,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type Command, plug } from "../plug-controller";
import { renderKey } from "../render";

/** Shared behaviour for Toggle / Turn On / Turn Off keys; they differ only in the command they send. */
abstract class PlugAction extends SingletonAction {
	protected abstract readonly command: Command;
	private lastImage = new Map<string, string>();

	constructor() {
		super();
		plug.onChange(() => void this.renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.lastImage.delete(ev.action.id);
		plug.keyAppeared(ev.action.id);
		await this.renderAll();
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.lastImage.delete(ev.action.id);
		plug.keyDisappeared(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const result = await plug.press(this.command);
		// "locked" and "busy" are silent by design: pressing during the timer does nothing.
		if (result === "error" || result === "not-configured") await ev.action.showAlert();
	}

	private async renderAll(): Promise<void> {
		const view = plug.view;
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			const image = renderKey(this.command, view);
			if (this.lastImage.get(a.id) === image) continue;
			this.lastImage.set(a.id, image);
			await a.setImage(image);
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
