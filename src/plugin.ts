import streamDeck from "@elgato/streamdeck";

import { TogglePlug, TurnOffPlug, TurnOnPlug } from "./actions/plug-action";
import { type GlobalSettings, plug } from "./plug-controller";

// Keep "info": "trace" would write every message, including the Tapo password, into the log files.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new TogglePlug());
streamDeck.actions.registerAction(new TurnOnPlug());
streamDeck.actions.registerAction(new TurnOffPlug());

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => plug.applySettings(ev.settings));

// Property Inspector asks for the live plug status to show under the settings.
streamDeck.ui.onSendToPlugin<{ event?: string }>(async (ev) => {
	if (ev.payload?.event === "getStatus") {
		const v = plug.view;
		await streamDeck.ui.sendToPropertyInspector({
			event: "status",
			configured: v.configured,
			on: v.on ?? null,
			error: v.error ?? null,
			lockRemaining: v.lockRemaining,
		});
	}
});

await streamDeck.connect();
plug.applySettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
