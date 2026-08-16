import { test, expect } from "./helpers/mockedTest";
import { devices, type Page } from "@playwright/test";
import { clickSidebarSession, openMobileSidebar } from "./helpers/sidebar";

// A tap on the structured-view transcript must NOT focus the composer: on a
// coarse pointer that would pop the soft keyboard over the transcript, and the
// composer is only meant to focus when tapped directly. The live terminal keeps
// tap-to-focus (#2243) plus its keyboard FAB, so the toggle stays there.

test.use({ ...devices["iPhone 13"] });

const SESSION_ID = "sess-acp-tap";
const TITLE = "acp-tap";

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
            project_path: "/tmp/acp-tap",
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

async function openStructuredSession(page: Page) {
  await page.goto("/");
  await expect(page.locator("header")).toBeVisible();
  await openMobileSidebar(page);
  await clickSidebarSession(page, TITLE);
  await expect(page.getByTestId("structured-view-root")).toBeVisible({ timeout: 10000 });
}

test.describe("Structured-view transcript tap keeps the composer unfocused", () => {
  test("tapping the transcript does not focus the composer or pop the keyboard", async ({ page }) => {
    await setup(page);
    await openStructuredSession(page);

    const composer = page.getByPlaceholder(/Send a message/);
    await expect(composer).toBeVisible();
    // Start from an unfocused composer; the tap must not move focus into it.
    await composer.blur();
    await expect(composer).not.toBeFocused();

    // Tap an empty area near the top of the transcript (away from the centered
    // starter-prompt buttons) so the tap lands on non-interactive content.
    await page.getByTestId("acp-viewport").click({ position: { x: 8, y: 8 } });

    await expect(composer).not.toBeFocused();
  });
});
