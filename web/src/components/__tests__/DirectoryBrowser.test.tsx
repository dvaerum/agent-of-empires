// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BrowseResponse } from "../../lib/types";

const browseFilesystem = vi.fn();
const getHomePath = vi.fn();

vi.mock("../../lib/api", () => ({
  browseFilesystem: (...args: unknown[]) => browseFilesystem(...args),
  getHomePath: () => getHomePath(),
}));

import { DirectoryBrowser } from "../DirectoryBrowser";

function response(entries: BrowseResponse["entries"]): BrowseResponse & { ok: boolean } {
  return { entries, has_more: false, ok: true };
}

function dir(name: string, path = `/home/user/${name}`) {
  return { name, path, is_dir: true, is_git_repo: false };
}

afterEach(() => {
  window.localStorage.clear();
  browseFilesystem.mockReset();
  getHomePath.mockReset();
});

describe("DirectoryBrowser", () => {
  it("falls back to home when the initial path cannot be loaded, and selects it via 'Use this folder'", async () => {
    getHomePath.mockResolvedValue("/home/user");
    browseFilesystem.mockImplementation(async (path: string) => {
      if (path === "/missing") return { entries: [], has_more: false, ok: false };
      return response([dir("project")]);
    });
    const onSelect = vi.fn();

    render(<DirectoryBrowser initialPath="/missing" onSelect={onSelect} />);

    await expect(screen.findByRole("option", { name: /project/i })).resolves.toBeTruthy();
    expect(browseFilesystem).toHaveBeenNthCalledWith(1, "/missing", 100, undefined, false);
    expect(browseFilesystem).toHaveBeenNthCalledWith(2, "/home/user", 100, undefined, false);
    // The current folder is selectable even when it is not a git repo.
    fireEvent.click(screen.getByRole("button", { name: /use this folder/i }));
    expect(onSelect).toHaveBeenCalledWith("/home/user");
  });

  it("ignores stale browse responses after a newer navigation finishes", async () => {
    getHomePath.mockResolvedValue("/home/user");
    let resolveSlow!: (value: BrowseResponse & { ok: boolean }) => void;
    const slowResponse = new Promise<BrowseResponse & { ok: boolean }>((resolve) => {
      resolveSlow = resolve;
    });
    browseFilesystem
      .mockResolvedValueOnce(response([dir("slow")]))
      .mockReturnValueOnce(slowResponse)
      .mockResolvedValueOnce(response([dir("newer-child")]));

    render(<DirectoryBrowser onSelect={vi.fn()} />);

    await screen.findByRole("option", { name: /slow/i });
    fireEvent.click(screen.getByRole("option", { name: /slow/i }));
    fireEvent.click(screen.getByRole("button", { name: "~" }));

    await screen.findByRole("option", { name: /newer-child/i });
    expect(browseFilesystem).toHaveBeenNthCalledWith(2, "/home/user/slow", 100, undefined, false);
    expect(browseFilesystem).toHaveBeenNthCalledWith(3, "/home/user", 100, undefined, false);

    await act(async () => {
      resolveSlow(response([dir("stale-child", "/home/user/slow/stale-child")]));
      await slowResponse;
    });
    expect(screen.queryByRole("option", { name: /stale-child/i })).toBeNull();
    expect(screen.getByRole("option", { name: /newer-child/i })).toBeTruthy();
  });

  it("requests filtered results from the server so entries past the first page can be found", async () => {
    getHomePath.mockResolvedValue("/home/user");
    const firstPage = Array.from({ length: 100 }, (_, i) => dir(`project-${i + 1}`));
    browseFilesystem.mockImplementation(async (_path: string, _limit: number, filter?: string) => {
      if (filter === "z") return response([dir("z-project")]);
      return { entries: firstPage, has_more: true, ok: true };
    });

    render(<DirectoryBrowser onSelect={vi.fn()} />);

    await screen.findByRole("option", { name: "project-1" });
    expect(screen.queryByRole("option", { name: /z-project/i })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Type to filter..."), {
      target: { value: "z" },
    });

    await waitFor(() => {
      expect(browseFilesystem).toHaveBeenCalledWith("/home/user", 100, "z", false);
    });
    await expect(screen.findByRole("option", { name: /z-project/i })).resolves.toBeTruthy();
  });

  it("requests hidden folders when the toggle is on, keeping the filter and resetting pagination", async () => {
    getHomePath.mockResolvedValue("/home/user");
    const firstPage = Array.from({ length: 100 }, (_, i) => dir(`project-${i + 1}`));
    browseFilesystem.mockImplementation(
      async (_path: string, _limit: number, _filter?: string, showHidden?: boolean) => {
        if (showHidden) return response([dir(".hidden-proj", "/home/user/.hidden-proj")]);
        return { entries: firstPage, has_more: true, ok: true };
      },
    );

    render(<DirectoryBrowser onSelect={vi.fn()} />);

    await screen.findByRole("option", { name: "project-1" });
    // Page past the first 100 so the toggle has an expanded limit to reset.
    fireEvent.click(screen.getByRole("button", { name: /load 100 more/i }));
    await waitFor(() => {
      expect(browseFilesystem).toHaveBeenCalledWith("/home/user", 200, "", false);
    });

    fireEvent.change(screen.getByPlaceholderText("Type to filter..."), {
      target: { value: "proj" },
    });
    await waitFor(() => {
      expect(browseFilesystem).toHaveBeenCalledWith("/home/user", 100, "proj", false);
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /show hidden folders/i }));

    await waitFor(() => {
      expect(browseFilesystem).toHaveBeenLastCalledWith("/home/user", 100, "proj", true);
    });
    await expect(screen.findByRole("option", { name: /\.hidden-proj/ })).resolves.toBeTruthy();
  });
});

describe("DirectoryBrowser navigation above the home directory", () => {
  // The server refuses any path outside the home directory with a 400, so no control may request one.
  const requestedPaths = () => browseFilesystem.mock.calls.map((call) => call[0] as string);

  async function openAt(path: string, home: string | null = "/home/user") {
    getHomePath.mockResolvedValue(home);
    browseFilesystem.mockImplementation(async (requested: string) => {
      if (!requested.startsWith("/home/user")) return { entries: [], has_more: false, ok: false };
      return response([dir("child", `${requested}/child`)]);
    });
    render(<DirectoryBrowser initialPath={path} onSelect={vi.fn()} />);
    await screen.findByRole("option", { name: /child/i });
    browseFilesystem.mockClear();
  }

  it("goes to the home directory from the ~ button, not to its first path segment", async () => {
    await openAt("/home/user/a/b");

    fireEvent.click(screen.getByRole("button", { name: "~" }));

    await waitFor(() => expect(requestedPaths()).toEqual(["/home/user"]));
  });

  it("lists only the folders below home as breadcrumbs, each navigating inside home", async () => {
    await openAt("/home/user/a/b");

    expect(screen.queryByRole("button", { name: "home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "user" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "a" }));

    await waitFor(() => expect(requestedPaths()).toEqual(["/home/user/a"]));
  });

  it("keeps the first folder below home reachable when the breadcrumb is truncated", async () => {
    await openAt("/home/user/a/b/c/d");

    fireEvent.click(screen.getByRole("button", { name: "a" }));

    await waitFor(() => expect(requestedPaths()).toEqual(["/home/user/a"]));
  });

  it("offers a parent link below home but none at home itself", async () => {
    await openAt("/home/user/a");
    fireEvent.click(screen.getByRole("option", { name: /parent directory/i }));
    await waitFor(() => expect(requestedPaths()).toEqual(["/home/user"]));
    await screen.findByRole("option", { name: /child/i });

    expect(screen.queryByRole("option", { name: /parent directory/i })).toBeNull();
  });

  it("shows the whole path when the home directory is unknown", async () => {
    await openAt("/home/user/a", null);

    expect(screen.getByRole("button", { name: "home" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "user" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /parent directory/i })).toBeTruthy();
  });
});
