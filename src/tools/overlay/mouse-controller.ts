import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { renderHeader } from "./render-frame.ts";
import { getItemRowCount } from "./render-list.ts";
import type { OverlayState, TabDef, Theme } from "./render-types.ts";

export function handleListMouse(
	state: OverlayState,
	event: TuiMouseEvent,
	tabs: TabDef[],
	theme: Theme,
	bodyHeight: number,
	keepSelectionVisible: () => void,
): TuiMouseEventResult | undefined {
	if (state.view.kind !== "list" || state.activeTab === "orchestrator" || event.button !== "left") return undefined;
	const headerHeight = renderHeader(state, tabs, theme, event.width).length;
	if (event.y < headerHeight || event.y >= headerHeight + bodyHeight) return undefined;
	const row = event.y - headerHeight + (state.listScroll[state.activeTab] ?? 0);
	let start = 0;
	let index: number | undefined;
	for (let candidate = 0; candidate < state.items.length; candidate++) {
		const count = getItemRowCount(state.items[candidate], state.activeTab, event.width);
		if (row < start + count) {
			index = candidate;
			break;
		}
		start += count;
	}
	if (index === undefined) return undefined;

	state.selectedIndex = index;
	keepSelectionVisible();
	if (event.type === "press") return { handled: true, capture: true, focus: true };
	if (event.type !== "click") return undefined;
	if ((event.clickCount ?? 1) >= 2) state.view = { kind: "detail", item: state.items[index], scroll: 0 };
	return { handled: true, focus: true };
}
