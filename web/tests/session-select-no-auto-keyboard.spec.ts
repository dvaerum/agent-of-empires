import { test, expect } from "./helpers/mockedTest";
import { devices } from "@playwright/test";
import { clickSidebarSession, openMobileSidebar } from "./helpers/sidebar";
import { mockTerminalApis } from "./helpers/terminal-mocks";

// Selecting a session on a coarse pointer must not auto-focus its input (and
// so pop the soft keyboard) by default: autoOpenKeyboard defaults to off, so
// a monitoring-first workflow doesn't get the keyboard popped on every
// session switch. App.tsx's handleSelectSession/handleSelectWorkspace gate
// BOTH the structured composer and the terminal input the same way (a single
// `if (webSettings.autoOpenKeyboard)` branch), so this covers both view types
// with no explicit settings seed — exercising the real default.

test.use({ ...devices["iPhone 13"] });

test.describe("Session select does not auto-open the keyboard by default", () => {
  test("selecting a terminal session does not focus its input", async ({ page }) => {
    await mockTerminalApis(page);
    await page.route("**/api/sessions/*/ensure", (r) => r.fulfill({ json: { ok: true } }));
    await page.goto("/");
    await openMobileSidebar(page);
    await clickSidebarSession(page, "pinch-test");
    await page.locator("[data-live-terminal]").waitFor({ state: "visible", timeout: 10_000 });

    await expect(page.getByLabel("Live terminal input")).not.toBeFocused();
  });

  test("selecting a structured session does not focus the composer", async ({ page }) => {
    const sessionId = "sess-acp-select";
    const title = "acp-select";
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
              id: sessionId,
              title,
              project_path: "/tmp/acp-select",
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

    await page.goto("/");
    await expect(page.locator("header")).toBeVisible();
    await openMobileSidebar(page);
    await clickSidebarSession(page, title);
    await expect(page.getByTestId("structured-view-root")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByPlaceholder(/Send a message/)).not.toBeFocused();
  });
});
