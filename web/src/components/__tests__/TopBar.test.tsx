// @vitest-environment jsdom
//
// Presentational contract test for TopBar. TopBar is a pure prop-driven
// component (it pulls no data on its own), so this suite renders it
// directly with the prop permutations we care about and asserts the
// surface badges/buttons match. The full mounted topbar is exercised
// end-to-end in web/tests/top-bar.spec.ts; that suite covers menu
// interaction but cannot exercise the dev-build badge without mocking
// `/api/about`, which is what this Vitest file does instead.
//
// Part of #1055 (DEV build badge so concurrently-running debug/release
// instances on ports 8081 / 8080 are visually distinguishable).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TopBar } from "../TopBar";
import type { SessionResponse, Workspace } from "../../lib/types";

afterEach(() => {
  cleanup();
});

function renderTopBar(
  overrides: {
    isDevBuild?: boolean;
    isOffline?: boolean;
    activeWorkspace?: Workspace;
    activeSession?: SessionResponse | null;
    onOpenTips?: () => void;
    onEnterImmersive?: () => void;
  } = {},
) {
  return render(
    <TopBar
      activeWorkspace={overrides.activeWorkspace}
      activeSession={overrides.activeSession ?? null}
      onToggleSidebar={vi.fn()}
      onOpenPalette={vi.fn()}
      onToggleDiff={vi.fn()}
      paneIds={["diff", "terminal"]}
      paneDescriptor={(id) => ({ title: id, icon: (() => null) as never })}
      isPaneOpen={() => true}
      onTogglePane={vi.fn()}
      onOpenHelp={vi.fn()}
      onOpenAbout={vi.fn()}
      onStartTutorial={vi.fn()}
      onLogout={vi.fn()}
      loginRequired={false}
      isOffline={overrides.isOffline ?? false}
      isDevBuild={overrides.isDevBuild ?? false}
      onOpenTips={overrides.onOpenTips ?? vi.fn()}
      onGoDashboard={vi.fn()}
      onEnterImmersive={overrides.onEnterImmersive}
      sidebarColumnVisible={false}
      rightColumnVisible={false}
    />,
  );
}

describe("TopBar", () => {
  it("renders the DEV badge when isDevBuild=true", () => {
    const { getByLabelText, getByText } = renderTopBar({ isDevBuild: true });
    const badge = getByLabelText("Debug build");
    expect(badge).toBeTruthy();
    expect(getByText("DEV")).toBeTruthy();
  });

  it("does not render the DEV badge when isDevBuild=false", () => {
    const { queryByLabelText, queryByText } = renderTopBar({
      isDevBuild: false,
    });
    expect(queryByLabelText("Debug build")).toBeNull();
    expect(queryByText("DEV")).toBeNull();
  });

  it("does not render the workspace/repo breadcrumb even with an active workspace and session", () => {
    const workspace = {
      id: "ws-1",
      branch: null,
      projectPath: "/home/user/breadcrumb-repo",
      displayName: "breadcrumb-feature",
      agents: [],
      primaryAgent: "claude",
      status: "idle",
      sessions: [],
    } as unknown as Workspace;
    const { queryByText } = renderTopBar({
      activeWorkspace: workspace,
      activeSession: {} as SessionResponse,
    });
    // The old breadcrumb rendered the repo name (last path segment) and the
    // workspace display name; both must be gone now that #1456 removed it.
    expect(queryByText("breadcrumb-repo")).toBeNull();
    expect(queryByText("breadcrumb-feature")).toBeNull();
  });

  it("renders the offline badge independent of the DEV badge", () => {
    const { getByText, getByLabelText } = renderTopBar({
      isDevBuild: true,
      isOffline: true,
    });
    expect(getByText("offline")).toBeTruthy();
    expect(getByLabelText("Debug build")).toBeTruthy();
  });

  it("exposes a Tips entry in the overflow menu that fires onOpenTips", () => {
    const onOpenTips = vi.fn();
    const { getByRole } = renderTopBar({ onOpenTips });
    fireEvent.click(getByRole("button", { name: "More options" }));
    fireEvent.click(getByRole("menuitem", { name: "Tips" }));
    expect(onOpenTips).toHaveBeenCalledTimes(1);
  });

  it("shows Immersive mode only when onEnterImmersive is provided, and fires it", () => {
    // Absent without the handler (e.g. non-shell / test contexts).
    const bare = renderTopBar();
    fireEvent.click(bare.getByRole("button", { name: "More options" }));
    expect(bare.queryByRole("menuitem", { name: "Immersive mode" })).toBeNull();
    cleanup();
    // Present + wired when the shell passes the handler.
    const onEnterImmersive = vi.fn();
    const { getByRole } = renderTopBar({ onEnterImmersive });
    fireEvent.click(getByRole("button", { name: "More options" }));
    fireEvent.click(getByRole("menuitem", { name: "Immersive mode" }));
    expect(onEnterImmersive).toHaveBeenCalledTimes(1);
  });
});

describe("TopBar fullscreen toggle", () => {
  const requestFullscreen = vi.fn().mockResolvedValue(undefined);
  const exitFullscreen = vi.fn().mockResolvedValue(undefined);

  function setFullscreenApi(opts: { enabled: boolean; element?: Element | null }) {
    Object.defineProperty(document, "fullscreenEnabled", {
      value: opts.enabled,
      configurable: true,
    });
    Object.defineProperty(document, "fullscreenElement", {
      value: opts.element ?? null,
      configurable: true,
    });
    document.documentElement.requestFullscreen = requestFullscreen as never;
    document.exitFullscreen = exitFullscreen as never;
  }

  afterEach(() => {
    cleanup();
    requestFullscreen.mockClear();
    exitFullscreen.mockClear();
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
  });

  it("offers Full screen and requests fullscreen when supported and not fullscreen", () => {
    setFullscreenApi({ enabled: true, element: null });
    const { getByRole } = renderTopBar();
    fireEvent.click(getByRole("button", { name: "More options" }));
    fireEvent.click(getByRole("menuitem", { name: "Full screen" }));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("offers Exit full screen and exits when already fullscreen", () => {
    setFullscreenApi({ enabled: true, element: document.documentElement });
    const { getByRole } = renderTopBar();
    fireEvent.click(getByRole("button", { name: "More options" }));
    fireEvent.click(getByRole("menuitem", { name: "Exit full screen" }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("hides the item where the Fullscreen API is unsupported", () => {
    setFullscreenApi({ enabled: false });
    const { getByRole, queryByRole } = renderTopBar();
    fireEvent.click(getByRole("button", { name: "More options" }));
    expect(queryByRole("menuitem", { name: "Full screen" })).toBeNull();
    expect(queryByRole("menuitem", { name: "Exit full screen" })).toBeNull();
  });
});
