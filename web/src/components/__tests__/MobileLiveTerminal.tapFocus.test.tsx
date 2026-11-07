// @vitest-environment jsdom
//
// Tapping anywhere on the terminal content focuses the hidden input on a fine
// (desktop) pointer, so typing works without hunting for the exact spot. On a
// coarse (touch) pointer this used to ALSO pop the soft keyboard on any tap
// (including just scrolling through history, see #2243) — the keyboard FAB
// (KeyboardFab, rendered only on coarse pointers) already gives an explicit
// show/hide toggle there, so touch taps are left alone. The focus is
// synchronous inside the click handler for iOS, the active-element guard skips
// a redundant re-focus, and a live text selection is left alone so
// select-to-copy keeps working on desktop.

import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installResizeObserver, renderLiveTerminal } from "./liveTerminalHarness";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({ settings: { mobileFontSize: 14, desktopFontSize: 14 }, update: vi.fn() }),
}));
installResizeObserver();

// A minimal matchMedia stub so a test can force `(pointer: coarse)`. jsdom has
// no matchMedia by default, which is why the other tests in this file (no
// stub installed) already exercise the fine-pointer / desktop path.
function stubCoarsePointer() {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    media: "(pointer: coarse)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

describe("MobileLiveTerminal tap-to-focus", () => {
  it("focuses the hidden input when the terminal is tapped (fine/desktop pointer)", () => {
    const { scroller, input } = renderLiveTerminal();
    fireEvent.click(scroller);
    expect(document.activeElement).toBe(input());
  });

  it("leaves an active text selection alone so select-to-copy works", () => {
    const { scroller, input } = renderLiveTerminal();
    const range = document.createRange();
    range.selectNodeContents(scroller);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(scroller);
    expect(document.activeElement).not.toBe(input());
  });

  it("does not focus the hidden input on a coarse (touch) pointer tap — the keyboard FAB handles that", () => {
    stubCoarsePointer();
    const { scroller, input } = renderLiveTerminal();
    expect(document.activeElement).not.toBe(input());
    fireEvent.click(scroller);
    expect(document.activeElement).not.toBe(input());
  });
});
