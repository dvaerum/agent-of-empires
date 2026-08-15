// Mocked port of the live acp-config-pickers-ui spec: browser-driven
// user stories for the structured view model + reasoning effort pickers
// (#1403), replaying canned ConfigOptionsUpdated frames instead of a
// real daemon. The live acp-config-pickers spec (KEPT) pins the HTTP /
// replay wire shape against the real backend; this one drives the
// actual React surface: click the chip, pick a value, watch the chip
// reflect the adapter's confirming snapshot.
//
// The UI is pessimistic: the chip only moves once the confirming
// `ConfigOptionsUpdated` frame lands, so each test's `onConfigOption`
// handler plays the adapter's confirmation (or rejection).

import { test, expect } from "./helpers/mockedTest";
import {
  mockAcpSession,
  openStructuredSession,
  configOptionsUpdated,
  configOptionSwitchFailed,
} from "./helpers/acpMock";

function modelOption(current: string) {
  return {
    id: "model",
    name: "Model",
    category: "model",
    current_value: current,
    options: [
      { value: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ],
  };
}

function effortOption(current: string) {
  return {
    id: "effort",
    name: "Reasoning Effort",
    category: "thought_level",
    current_value: current,
    options: [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  };
}

function snapshot(model: string, effort: string) {
  return configOptionsUpdated([modelOption(model), effortOption(effort)]);
}

function longModelOption(count: number) {
  return {
    id: "model",
    name: "Model",
    category: "model",
    current_value: "model-1",
    options: Array.from({ length: count }, (_, i) => ({
      value: `model-${i + 1}`,
      name: `Model ${i + 1}`,
    })),
  };
}

function longModeOption(count: number) {
  return {
    id: "mode",
    name: "Agent Modes",
    category: "mode",
    current_value: "mode-1",
    options: Array.from({ length: count }, (_, i) => ({
      value: `mode-${i + 1}`,
      name: `Mode ${i + 1}`,
    })),
  };
}

test("user sees model and effort pickers after the adapter advertises config options", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "ui-pickers-render",
    initialEvents: [snapshot("claude-opus-4-7", "default")],
  });
  await openStructuredSession(page, mock);

  const modelChip = page.getByTestId("config-option-model");
  await expect(modelChip).toBeVisible({ timeout: 15_000 });
  await expect(modelChip).toContainText("Claude Opus 4.7");

  const effortControl = page.getByTestId("config-option-effort");
  await expect(effortControl).toBeVisible();
  await expect(effortControl).toContainText("Default");
  await expect(effortControl).toContainText("High");
});

test("user switches the model and the chip reflects the adapter confirmation", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "ui-pickers-switch-model",
    initialEvents: [snapshot("claude-opus-4-7", "default")],
    // The adapter accepts the switch and resends the full snapshot with
    // the new current value.
    onConfigOption: (body) => [snapshot(body.value, "default")],
  });
  await openStructuredSession(page, mock);

  const modelChip = page.getByTestId("config-option-model");
  await expect(modelChip).toBeVisible({ timeout: 15_000 });
  await expect(modelChip).toContainText("Claude Opus 4.7");

  await modelChip.click();
  await page.getByTestId("config-option-model-value-claude-sonnet-4-6").click();

  // POST shape: { config_id: "model", value: "claude-sonnet-4-6" }.
  await expect.poll(() => mock.configOptionBodies.length).toBeGreaterThan(0);
  expect(mock.configOptionBodies[0]).toEqual({
    config_id: "model",
    value: "claude-sonnet-4-6",
  });

  // Adapter's confirming snapshot lands via WS; chip updates.
  await expect(modelChip).toContainText("Claude Sonnet 4.6", {
    timeout: 10_000,
  });
});

test("user picks reasoning effort and the segment becomes active", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "ui-pickers-switch-effort",
    initialEvents: [snapshot("claude-opus-4-7", "default")],
    onConfigOption: (body) => [snapshot("claude-opus-4-7", body.value)],
  });
  await openStructuredSession(page, mock);

  const effortControl = page.getByTestId("config-option-effort");
  await expect(effortControl).toBeVisible({ timeout: 15_000 });

  const highSegment = page.getByTestId("config-option-effort-value-high");
  await highSegment.click();

  // After the adapter confirms, the High radio reports
  // aria-checked=true and Default no longer does.
  await expect(highSegment).toHaveAttribute("aria-checked", "true", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("config-option-effort-value-default")).toHaveAttribute("aria-checked", "false");
});

test("rejected switch renders a dismissable non-blocking notice", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "ui-pickers-reject",
    initialEvents: [snapshot("claude-opus-4-7", "default")],
    // The adapter rejects the switch; the daemon broadcasts the failure
    // frame instead of a confirming snapshot.
    onConfigOption: (body) => [configOptionSwitchFailed(body.config_id, body.value, "rate limited (test)")],
  });
  await openStructuredSession(page, mock);

  const modelChip = page.getByTestId("config-option-model");
  await expect(modelChip).toBeVisible({ timeout: 15_000 });
  await modelChip.click();
  await page.getByTestId("config-option-model-value-claude-sonnet-4-6").click();

  const notice = page.getByTestId("config-option-switch-failed-notice");
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText("rate limited (test)");

  // Chip stays on the previously-current value: pessimistic UI.
  await expect(modelChip).toContainText("Claude Opus 4.7");

  // Manual dismiss removes the notice.
  await notice.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(notice).toHaveCount(0);
});

test("long model list stays in the viewport and scrolls on short screens", async ({ page }) => {
  // A phone-height viewport (e.g. with the software keyboard up): the model
  // dropdown opens upward and used to extend past the top of the viewport,
  // clipping the first rows with no way to scroll them. The menu must cap
  // its height to the space above the trigger and scroll instead.
  await page.setViewportSize({ width: 320, height: 568 });
  const mock = await mockAcpSession(page, {
    title: "ui-pickers-long-model",
    initialEvents: [configOptionsUpdated([longModelOption(20)])],
  });
  await openStructuredSession(page, mock);

  const modelChip = page.getByTestId("config-option-model");
  await expect(modelChip).toBeVisible({ timeout: 15_000 });
  await modelChip.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();

  // The menu is a scroll container that fits the viewport above the trigger.
  const fitsViewport = () => menu.boundingBox().then((box) => Boolean(box && box.y >= 0 && box.y + box.height <= 568));
  await expect.poll(fitsViewport).toBe(true);
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

  // The first row is reachable without scrolling...
  const first = page.getByTestId("config-option-model-value-model-1");
  await expect.poll(() => first.boundingBox().then((b) => Boolean(b && b.y >= 0 && b.y <= 568))).toBe(true);

  // ...and the last row becomes reachable once the menu is scrolled to the bottom.
  const last = page.getByTestId("config-option-model-value-model-20");
  await menu.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => last.boundingBox().then((b) => Boolean(b && b.y >= 0 && b.y <= 568))).toBe(true);
});

test("long mode list stays in the viewport and scrolls on short screens", async ({ page }) => {
  // Same clipping hazard as the model dropdown: the composer's mode menu
  // also opens upward and used to extend past the top of the viewport.
  await page.setViewportSize({ width: 320, height: 568 });
  const mock = await mockAcpSession(page, {
    title: "ui-pickers-long-mode",
    initialEvents: [configOptionsUpdated([longModeOption(20)])],
  });
  await openStructuredSession(page, mock);

  const modePicker = page.locator('[data-tour="acp-mode-picker"]');
  await expect(modePicker).toBeVisible({ timeout: 15_000 });
  await modePicker.getByRole("button").click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();

  const fitsViewport = () => menu.boundingBox().then((box) => Boolean(box && box.y >= 0 && box.y + box.height <= 568));
  await expect.poll(fitsViewport).toBe(true);
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

  const first = page.getByRole("menuitem", { name: "Mode 1", exact: true });
  await expect.poll(() => first.boundingBox().then((b) => Boolean(b && b.y >= 0 && b.y <= 568))).toBe(true);

  const last = page.getByRole("menuitem", { name: "Mode 20", exact: true });
  await menu.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => last.boundingBox().then((b) => Boolean(b && b.y >= 0 && b.y <= 568))).toBe(true);
});
