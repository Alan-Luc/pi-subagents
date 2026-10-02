import { getItemRowCount } from "./render-list.ts";
import type { OverlayState } from "./render-types.ts";

export function keepListSelectionVisible(state: OverlayState, width: number, height: number): void {
	let start = 0;
	for (let index = 0; index < state.selectedIndex; index++) {
		start += getItemRowCount(state.items[index], state.activeTab, width);
	}
	const selectedHeight = state.items[state.selectedIndex]
		? getItemRowCount(state.items[state.selectedIndex], state.activeTab, width)
		: 1;
	const end = start + selectedHeight;
	const current = state.listScroll[state.activeTab] ?? 0;
	let next = current;
	if (start < current) next = start;
	else if (end > current + height) next = Math.max(0, end - height);
	state.listScroll = { ...state.listScroll, [state.activeTab]: next };
}
