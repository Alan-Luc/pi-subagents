import type { OverlayItem, OverlayState, SessionViewState } from "./render-types.ts";

export function replaceOverlayItems(
	state: OverlayState,
	items: OverlayItem[],
	refreshSession: (view: SessionViewState, item: OverlayItem) => SessionViewState,
	keepSelectionVisible: () => void,
): void {
	const selectedId = state.items[state.selectedIndex]?.id;
	state.items = items;
	if (selectedId) {
		const nextIndex = items.findIndex((item) => item.id === selectedId);
		if (nextIndex >= 0) state.selectedIndex = nextIndex;
	}
	state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, state.items.length - 1));
	keepSelectionVisible();
	const view = state.view;
	if (view.kind === "detail") {
		const item = items.find((candidate) => candidate.id === view.item.id);
		if (item) state.view = { ...view, item };
	} else if (view.kind === "session") {
		const item = items.find((candidate) => candidate.id === view.item.id);
		if (item) state.view = refreshSession(view, item);
	}
}
