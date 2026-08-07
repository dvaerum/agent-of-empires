// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useImmersive } from "../useImmersive";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useImmersive", () => {
  it("enters, exits, exits on Escape, and persists across mounts", () => {
    const { result, unmount } = renderHook(() => useImmersive());
    expect(result.current.active).toBe(false);

    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    expect(localStorage.getItem("aoe.immersive")).toBe("1");

    // Escape exits while active.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.active).toBe(false);

    // Re-enter, then a fresh mount restores the persisted state.
    act(() => result.current.enter());
    unmount();
    const remount = renderHook(() => useImmersive());
    expect(remount.result.current.active).toBe(true);
    act(() => remount.result.current.exit());
    expect(remount.result.current.active).toBe(false);
  });
});
