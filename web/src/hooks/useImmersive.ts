import { useCallback, useEffect, useState } from "react";
import { safeGetItem, safeSetItem } from "../lib/safeStorage";

const STORAGE_KEY = "aoe.immersive";

/**
 * App-chrome "immersive" mode: hide the top bar and sidebar so the main pane
 * fills the viewport. Unlike the browser Fullscreen API (unavailable on iPhone
 * Safari/Firefox, which share WebKit), this is pure layout, so it works in every
 * browser and is the mobile-friendly counterpart to the Fullscreen toggle.
 *
 * The state is persisted so it survives a reload, and Escape exits (there is no
 * top bar to click while immersive; the app renders a floating exit button too).
 */
export function useImmersive(): {
  active: boolean;
  enter: () => void;
  exit: () => void;
} {
  const [active, setActive] = useState(() => safeGetItem(STORAGE_KEY) === "1");

  const enter = useCallback(() => setActive(true), []);
  const exit = useCallback(() => setActive(false), []);

  useEffect(() => {
    safeSetItem(STORAGE_KEY, active ? "1" : "0");
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return { active, enter, exit };
}
