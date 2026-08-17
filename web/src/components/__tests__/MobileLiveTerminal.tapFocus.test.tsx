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

import { createRef } from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { MobileLiveTerminal } from "../MobileLiveTerminal";
import type { LiveFrame } from "../../hooks/useLiveTerminal";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({ settings: { mobileFontSize: 14 }, update: vi.fn() }),
}));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

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

const frame: LiveFrame = {
  content: "$ \n",
  rows: 3,
  history: 1000,
  cursor: null,
  altScreen: false,
  mouse: false,
  mouseSgr: false,
};

function renderTerm() {
  const inputRef = createRef<HTMLTextAreaElement>();
  const utils = render(
    <MobileLiveTerminal
      frame={frame}
      connected
      active
      reading={false}
      sendResize={vi.fn()}
      setWindow={vi.fn()}
      setCadence={vi.fn()}
      enterReading={vi.fn()}
      returnToLive={vi.fn()}
      sendData={vi.fn()}
      forwardWheel={vi.fn()}
      forwardButton={vi.fn()}
      ctrlActiveRef={createRef<boolean>() as React.RefObject<boolean>}
      clearCtrl={vi.fn()}
      inputRef={inputRef}
      onInputFocusChange={vi.fn()}
      bottomAlign
      keyboardOpen={false}
    />,
  );
  const scroller = utils.container.querySelector("[data-live-terminal]")!.firstElementChild as HTMLElement;
  return { scroller, inputRef, utils };
}

describe("MobileLiveTerminal tap-to-focus", () => {
  it("focuses the hidden input when the terminal is tapped (fine/desktop pointer)", () => {
    const { scroller, inputRef } = renderTerm();
    expect(document.activeElement).not.toBe(inputRef.current);
    fireEvent.click(scroller);
    expect(document.activeElement).toBe(inputRef.current);
  });

  it("does not steal focus from an active text selection", () => {
    const { scroller, inputRef } = renderTerm();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(scroller);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.isCollapsed).toBe(false);
    fireEvent.click(scroller);
    expect(document.activeElement).not.toBe(inputRef.current);
  });

  it("does not focus the hidden input on a coarse (touch) pointer tap — the keyboard FAB handles that", () => {
    stubCoarsePointer();
    const { scroller, inputRef } = renderTerm();
    expect(document.activeElement).not.toBe(inputRef.current);
    fireEvent.click(scroller);
    expect(document.activeElement).not.toBe(inputRef.current);
  });
});
