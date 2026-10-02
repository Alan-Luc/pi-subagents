import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getSessionMaxScroll, readSessionTranscript } from "./session-view.ts";
import type { OverlayItem, SessionViewState, Theme } from "./render-types.ts";

export function openSessionView(item: OverlayItem, theme: Theme, width: number, maxHeight: number): SessionViewState {
	const transcript = readSessionTranscript(item.sessionFile, {
		live: item.sessionLive === true,
		noSession: item.noSession,
	});
	return {
		kind: "session",
		item,
		transcript,
		scroll: getSessionMaxScroll(item, transcript, theme, width, maxHeight),
		followTail: true,
	};
}

export function handleSessionInput(
	data: string,
	view: SessionViewState,
	theme: Theme,
	width: number,
	maxHeight: number,
): SessionViewState | { kind: "detail"; item: OverlayItem; scroll: number } {
	if (matchesKey(data, Key.escape)) return { kind: "detail", item: view.item, scroll: 0 };
	const maxScroll = getSessionMaxScroll(view.item, view.transcript, theme, width, maxHeight);
	if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
		return { ...view, scroll: Math.max(0, view.scroll - 1), followTail: false };
	}
	if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
		const scroll = Math.min(maxScroll, view.scroll + 1);
		return { ...view, scroll, followTail: scroll >= maxScroll };
	}
	return view;
}

export function refreshSessionView(
	view: SessionViewState,
	item: OverlayItem,
	theme: Theme,
	width: number,
	maxHeight: number,
): SessionViewState {
	const transcript = readSessionTranscript(item.sessionFile, {
		live: item.sessionLive === true,
		noSession: item.noSession,
		previous: view.transcript,
	});
	const maxScroll = getSessionMaxScroll(item, transcript, theme, width, maxHeight);
	return {
		...view,
		item,
		transcript,
		scroll: view.followTail ? maxScroll : Math.min(view.scroll, maxScroll),
	};
}
