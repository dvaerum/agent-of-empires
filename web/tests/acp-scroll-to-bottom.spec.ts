import { test, expect } from "./helpers/mockedTest";
import type { Page } from "@playwright/test";
import { clickSidebarSession } from "./helpers/sidebar";

// The structured view renders a scroll-to-bottom pill (assistant-ui's
// ThreadPrimitive.ScrollToBottom) so long transcripts have a quick way back to
// the latest message. The control auto-hides (disabled) while pinned to the
// bottom, but it is always mounted in the DOM, so a fresh structured session
// renders it. This asserts the control ships and is wired with its stable
// test id / label.

const SESSION_ID = "sess-acp-scroll";
const TITLE = "acp-scroll";

async function setup(page: Page) {
  await page.route("**/api/login/status", (r) => r.fulfill({ json: { required: false, authenticated: true } }));
  for (const path of [
    "settings",
    "themes",
    "agents",
    "profiles",
    "groups",
    "devices",
    "docker/status",
    "about",
    "system/update-status",
  ]) {
    await page.route(`**/api/${path}`, (r) =>
      r.fulfill({
        json:
          path === "docker/status" || path === "about" || path === "settings" || path === "system/update-status"
            ? {}
            : [],
      }),
    );
  }
  await page.route("**/api/sessions", (r) => {
    if (r.request().method() === "POST") return r.fulfill({ status: 400 });
    return r.fulfill({
      json: {
        sessions: [
          {
            id: SESSION_ID,
            title: TITLE,
            project_path: "/tmp/acp-scroll",
            group_path: "/tmp",
            tool: "claude",
            status: "Running",
            yolo_mode: false,
            created_at: new Date().toISOString(),
            last_accessed_at: null,
            last_error: null,
            branch: null,
            main_repo_path: null,
            is_sandboxed: false,
            has_terminal: true,
            profile: "default",
            workspace_repos: [],
            view: "structured",
            acp_worker_state: "running",
            claude_fullscreen: false,
          },
        ],
        workspace_ordering: [],
      },
    });
  });
  await page.route("**/api/sessions/*/ensure", (r) => r.fulfill({ json: { ok: true } }));
  await page.route("**/api/sessions/*/acp/**", (r) => r.fulfill({ json: {} }));
  await page.routeWebSocket(/\/sessions\/[^/]+\/ws(\?|$)/, () => {});
  await page.routeWebSocket(/\/sessions\/[^/]+\/acp\/ws/, () => {});
}

test.describe("Structured-view scroll-to-bottom", () => {
  test("renders the scroll-to-bottom control", async ({ page }) => {
    await setup(page);
    await page.goto("/");
    await expect(page.locator("header")).toBeVisible();
    await clickSidebarSession(page, TITLE);
    await expect(page.getByTestId("structured-view-root")).toBeVisible({ timeout: 10000 });

    // Always mounted (auto-hidden at the bottom), so attached is the contract.
    const scroll = page.getByTestId("acp-scroll-to-bottom");
    await expect(scroll).toBeAttached();
    await expect(scroll).toHaveAttribute("aria-label", "Scroll to latest message");
  });
});
