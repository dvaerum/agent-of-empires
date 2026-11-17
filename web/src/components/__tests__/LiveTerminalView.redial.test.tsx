// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTerminalView } from "../LiveTerminalView";
import { installResizeObserver } from "./liveTerminalHarness";
import { makeSession } from "./fixtures";
import type { SessionResponse } from "../../lib/types";

const { ensureSession, restartSession } = vi.hoisted(() => ({
  ensureSession: vi.fn(async () => ({ ok: true, message: null })),
  restartSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/token", () => ({ getToken: () => null }));
vi.mock("../../lib/deviceBinding", () => ({ getOrCreateDeviceBindingSecret: () => "test-secret" }));
vi.mock("../../hooks/useIsCoarsePointer", () => ({ useIsCoarsePointer: () => false }));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardHeight: 0, keyboardOpen: false }),
}));
vi.mock("../../lib/api", () => ({
  ensureSession,
  ensureTerminal: vi.fn(async () => ({ ok: true })),
  restartSession,
  pasteImage: vi.fn(),
  isStartRefusal: () => false,
  reportTelemetrySeen: vi.fn(),
}));
const resize = installResizeObserver();

// A server-side Stop/Start recreates the pane under the page. These tests hold the page open on the real hook and
// drive only what the page can see: the session's status, and the socket the server did or did not close.
class FakeWS {
  static sockets: FakeWS[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.sockets.push(this);
  }
  send() {}
  /** The page's own close: a browser reports it through onclose a moment later. */
  close() {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    queueMicrotask(() => act(() => this.onclose?.(new CloseEvent("close", { code: 1005 }))));
  }
  open() {
    act(() => {
      this.readyState = FakeWS.OPEN;
      this.onopen?.({} as Event);
    });
  }
  deliver(payload: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent));
  }
  /** The server ends the socket, as the live-ws handler does with 1013 or 4001. */
  serverClose(code: number) {
    act(() => {
      this.readyState = FakeWS.CLOSED;
      this.onclose?.(new CloseEvent("close", { code }));
    });
  }
}

const frame = (content: string, seq = 1) => ({
  type: "frame",
  seq,
  content: `${content}\n`,
  rows: 3,
  history: 0,
  cursor: null,
  altScreen: false,
  mouse: false,
  mouseSgr: false,
  pane0: null,
});

const at = (status: SessionResponse["status"], readOnly = false, over: Partial<SessionResponse> = {}) => (
  <LiveTerminalView readOnly={readOnly} session={makeSession({ id: "r1", status, ...over })} />
);

const settle = (ms = 60) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** A page held open on a live socket that shows `content`. */
async function holdOpen(status: SessionResponse["status"], readOnly = false, content = "OLD-LAUNCH") {
  const view = render(at(status, readOnly));
  await waitFor(() => expect(FakeWS.sockets).toHaveLength(1));
  FakeWS.sockets[0]!.open();
  FakeWS.sockets[0]!.deliver(frame(content));
  return view;
}

beforeEach(() => {
  FakeWS.sockets.length = 0;
  ensureSession.mockClear();
  restartSession.mockClear();
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  resize.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveTerminalView redials when its session starts again", () => {
  it("opens exactly one new socket on Idle -> Stopped -> Starting although the old socket never closed", async () => {
    const { rerender } = await holdOpen("Idle");
    rerender(at("Stopped"));
    await settle();
    expect(FakeWS.sockets).toHaveLength(1);

    rerender(at("Starting"));
    await waitFor(() => expect(FakeWS.sockets).toHaveLength(2));
    FakeWS.sockets[1]!.open();
    FakeWS.sockets[1]!.deliver(frame("NEW-LAUNCH"));
    rerender(at("Running"));
    await settle();
    expect(FakeWS.sockets).toHaveLength(2);
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it.each<[string, SessionResponse["status"]]>([
    ["Idle", "Idle"],
    ["Running", "Running"],
  ])("redials once on %s -> Starting, a CLI restart that never shows Stopped", async (_name, from) => {
    const { rerender } = await holdOpen(from);
    rerender(at("Starting"));
    await waitFor(() => expect(FakeWS.sockets).toHaveLength(2));
    rerender(at("Running"));
    await settle();
    expect(FakeWS.sockets).toHaveLength(2);
  });

  it("dials at once when the retries ran out during a long stop", async () => {
    vi.useFakeTimers();
    const { rerender } = render(at("Idle"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    rerender(at("Stopped"));
    // The server answers 1013 while the session is down; the page backs off 7 times and gives up.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      FakeWS.sockets.at(-1)!.serverClose(1013);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
    }
    expect(FakeWS.sockets).toHaveLength(8);
    expect(screen.getByText("Connection lost")).toBeTruthy();

    rerender(at("Starting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(FakeWS.sockets).toHaveLength(9);
    FakeWS.sockets[8]!.open();
    FakeWS.sockets[8]!.deliver(frame("NEW-LAUNCH"));
    expect(screen.queryByText("Connection lost")).toBeNull();
  });

  it("leaves a socket the page already redialed after the close alone", async () => {
    const { rerender } = await holdOpen("Running");
    rerender(at("Stopped"));
    FakeWS.sockets[0]!.serverClose(1013);
    await waitFor(() => expect(FakeWS.sockets).toHaveLength(2));
    FakeWS.sockets[1]!.open();
    FakeWS.sockets[1]!.deliver(frame("NEW-LAUNCH"));

    rerender(at("Starting"));
    await settle();
    expect(FakeWS.sockets).toHaveLength(2);
  });

  it("does not dial while the session stays Stopped", async () => {
    const { rerender } = await holdOpen("Running");
    rerender(at("Stopped"));
    await settle(300);
    rerender(at("Stopped", false, { last_accessed_at: "2026-01-01T00:00:00Z" }));
    await settle(300);
    expect(FakeWS.sockets).toHaveLength(1);
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it("does not dial for a session that is being deleted", async () => {
    const { rerender } = await holdOpen("Running");
    rerender(at("Stopped"));
    rerender(at("Deleting"));
    await settle(300);
    expect(FakeWS.sockets).toHaveLength(1);
  });

  it("does not dial a session that is still being created", async () => {
    const { rerender } = await holdOpen("Idle");
    rerender(at("Creating"));
    rerender(at("Starting"));
    await settle(300);
    expect(FakeWS.sockets).toHaveLength(1);
  });

  it("is bounded when Starting flaps: one new socket, and another only after the cool-down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { rerender } = await holdOpen("Idle");
    rerender(at("Stopped"));
    rerender(at("Starting"));
    await waitFor(() => expect(FakeWS.sockets).toHaveLength(2));
    FakeWS.sockets[1]!.open();
    FakeWS.sockets[1]!.deliver(frame("NEW-LAUNCH"));
    FakeWS.sockets[1]!.serverClose(1013);

    rerender(at("Stopped"));
    rerender(at("Starting"));
    rerender(at("Stopped"));
    rerender(at("Starting"));
    await settle(20);
    // The hook's own backoff redials the close; the flaps add nothing.
    expect(FakeWS.sockets.length).toBeLessThanOrEqual(3);

    const before = FakeWS.sockets.length;
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    rerender(at("Stopped"));
    rerender(at("Starting"));
    await waitFor(() => expect(FakeWS.sockets.length).toBe(before + 1));
  });

  it("leaves a read-only view alone", async () => {
    const { rerender } = await holdOpen("Idle", true);
    rerender(at("Stopped", true));
    rerender(at("Starting", true));
    await settle(300);
    expect(FakeWS.sockets).toHaveLength(1);
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("does not add a dial to the Restart button's own redial", async () => {
    const { rerender } = await holdOpen("Running");
    FakeWS.sockets[0]!.serverClose(4001);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(ensureSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(FakeWS.sockets).toHaveLength(2));

    // The launch the Restart began reads Starting while its socket is still connecting.
    rerender(at("Starting"));
    await settle();
    expect(FakeWS.sockets).toHaveLength(2);
    FakeWS.sockets[1]!.open();
    await waitFor(() => expect(screen.queryByText("Agent exited")).toBeNull());
  });

  it("clears the Agent exited state and dials once on Error -> Starting", async () => {
    const { rerender } = await holdOpen("Running");
    FakeWS.sockets[0]!.serverClose(4001);
    await screen.findByText("Agent exited");
    rerender(at("Error", false, { last_error: "agent exited" }));
    expect(screen.getByTestId("session-error-panel")).toBeTruthy();

    fireEvent.click(screen.getByTestId("session-error-restart"));
    await waitFor(() => expect(restartSession).toHaveBeenCalledTimes(1));
    rerender(at("Starting"));
    await waitFor(() => expect(FakeWS.sockets).toHaveLength(2));
    await settle();
    expect(FakeWS.sockets).toHaveLength(2);
    expect(screen.queryByText("Agent exited")).toBeNull();
    FakeWS.sockets[1]!.open();
    FakeWS.sockets[1]!.deliver(frame("NEW-LAUNCH"));
    expect(screen.queryByText("Agent exited")).toBeNull();
  });
});
