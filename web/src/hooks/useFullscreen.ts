import { useCallback, useEffect, useState } from "react";

/**
 * Browser Fullscreen API toggle for the whole dashboard.
 *
 * `supported` is false where the Fullscreen API is unavailable (most visibly
 * iPhone Safari, which has no element-fullscreen), so callers can hide the
 * control rather than offer a dead button. `toggle` must be called from a user
 * gesture (a click handler qualifies); the promise rejections are swallowed
 * because a denied request is not actionable and should not surface an error.
 */
export function useFullscreen(): {
  supported: boolean;
  isFullscreen: boolean;
  toggle: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== "undefined" && document.fullscreenElement != null,
  );

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  const supported = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);

  return { supported, isFullscreen, toggle };
}
