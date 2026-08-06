// Restart-on-attach e2e for the web dashboard.
//
// Proves POST /api/sessions/{id}/ensure restarts a dead session and
// leaves a live one alone. Uses the harness's `seedFn` hook to run
// `aoe add` BEFORE serve boots so the server picks up the session in
// its initial `state.instances` cache load (a post-spawn `aoe add`
// writes to disk but the server never reloads).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { spawnAoeServe, listSessions, seedSessionViaAoeAdd, appDirFor, resolveAoeBinary } from "../helpers/aoeServe";

// aoe (debug build) routes tmux through an explicit `-S <socket>` and ignores
// TMUX_TMPDIR (#2608), so inspect sessions on the harness's pinned socket.
function tmuxHasSession(socket: string, name: string): boolean {
  const res = spawnSync("tmux", ["-S", socket, "has-session", "-t", name]);
  return res.status === 0;
}

base.describe("ensure_session restart flow", () => {
  base("dead session is restarted by /ensure, live session stays alive", async ({}, testInfo) => {
    const title = "e2e-restart";
    const serve = await spawnAoeServe({
      authMode: "none",
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      seedFn: seedSessionViaAoeAdd({ title }),
    });

    try {
      const sessions = await listSessions(serve.baseUrl);
      expect(sessions.length).toBeGreaterThan(0);
      const sessionId: string = sessions[0]!.id;
      const tmuxName = `${serve.tmuxPrefix}${title}_${sessionId.slice(0, 8)}`;

      // The server's status_poll_loop runs every 2s and reconciles the
      // on-disk session record (initial status: Idle) against tmux. There
      // is no tmux session for this seed, so it eventually flips to Error,
      // but a freshly booted server may not have polled yet.
      await expect
        .poll(async () => (await listSessions(serve.baseUrl))[0]?.status, {
          timeout: 10_000,
        })
        .toBe("Error");
      expect(tmuxHasSession(serve.tmuxSocket, tmuxName)).toBe(false);

      const r1 = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/ensure`, { method: "POST" });
      expect(r1.ok).toBeTruthy();
      expect((await r1.json()).status).toBe("restarted");
      expect(tmuxHasSession(serve.tmuxSocket, tmuxName)).toBe(true);

      const euid = process.getuid?.() ?? 0;
      const hookBase = `/tmp/aoe-hooks-${euid}`;
      mkdirSync(hookBase, { recursive: true });
      try {
        chmodSync(hookBase, 0o700);
      } catch {
        // best effort: if base is owned by us we can chmod, if not the
        // hook system would already be unusable for this user.
      }
      const hookDir = `${hookBase}/${sessionId}`;
      mkdirSync(hookDir, { recursive: true });
      try {
        chmodSync(hookDir, 0o700);
      } catch {
        // ignore
      }
      writeFileSync(join(hookDir, "status"), "idle");

      const r2 = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/ensure`, { method: "POST" });
      expect((await r2.json()).status).toBe("alive");

      const r3 = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/ensure`, { method: "POST" });
      expect((await r3.json()).status).toBe("alive");

      const kill = spawnSync("tmux", ["-S", serve.tmuxSocket, "kill-session", "-t", tmuxName]);
      expect(kill.status).toBe(0);

      const r4 = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/ensure`, { method: "POST" });
      expect((await r4.json()).status).toBe("restarted");

      try {
        rmSync(hookDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    } finally {
      await serve.stop();
    }
  });

  base("frontend shows Starting placeholder then connects", async ({ page }, testInfo) => {
    const title = "e2e-restart";
    const serve = await spawnAoeServe({
      authMode: "none",
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      seedFn: seedSessionViaAoeAdd({ title }),
    });

    try {
      const sessions = await listSessions(serve.baseUrl);
      expect(sessions.length).toBeGreaterThan(0);
      const sessionId: string = sessions[0]!.id;
      const tmuxName = `${serve.tmuxPrefix}${title}_${sessionId.slice(0, 8)}`;

      spawnSync("tmux", ["-S", serve.tmuxSocket, "kill-session", "-t", tmuxName]);

      // Delay /ensure so Playwright reliably observes the "pending"
      // placeholder. Without this the live backend can resolve the
      // restart before the assertion's first retry, and the placeholder
      // mounts + unmounts inside a single frame.
      await page.route("**/api/sessions/*/ensure", async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
      });

      await page.goto(`${serve.baseUrl}/`);
      const sessionButton = page.getByRole("link").filter({ hasText: "e2e-restart" }).first();
      await expect(sessionButton).toBeVisible();
      await sessionButton.click();

      // The desktop layout mounts both the agent pane and the paired shell
      // pane (each a LiveTerminalView), so the placeholder renders twice; only
      // the agent's /ensure is delayed above, and it is first in the DOM.
      await expect(page.getByText("Starting session...").first()).toBeVisible();
      await expect(page.getByText("Starting session...").first()).toBeHidden({
        timeout: 15_000,
      });
    } finally {
      await serve.stop();
    }
  });

  base("resume_stopped_on_open=false: /ensure does NOT relaunch a Stopped session", async ({}, testInfo) => {
    // With the setting off, opening (attaching to) a Stopped session must not
    // auto-launch its agent: /ensure returns 409 resume_on_open_disabled and no
    // tmux pane is created. The explicit Start action stays the only launcher.
    const title = "e2e-resume-off";
    const serve = await spawnAoeServe({
      authMode: "none",
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      seedFn: (seedEnv) => {
        const appDir = appDirFor(seedEnv.home, seedEnv.xdg, resolveAoeBinary());
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "config.toml"), "[session]\nresume_stopped_on_open = false\n");
        seedSessionViaAoeAdd({ title })(seedEnv);
      },
    });

    try {
      const sessions = await listSessions(serve.baseUrl);
      const sessionId: string = sessions[0]!.id;
      const tmuxName = `${serve.tmuxPrefix}${title}_${sessionId.slice(0, 8)}`;

      // Deliberately stop the session so its status is Stopped (the only status
      // the gate acts on; a crashed agent is Error/Running and is unaffected).
      const stopRes = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/stop`, { method: "POST" });
      expect(stopRes.ok).toBeTruthy();
      await expect
        .poll(async () => (await listSessions(serve.baseUrl)).find((s) => s.id === sessionId)?.status, {
          timeout: 10_000,
        })
        .toBe("Stopped");
      expect(tmuxHasSession(serve.tmuxSocket, tmuxName)).toBe(false);

      // /ensure must refuse to relaunch: 409 with the resume_on_open_disabled
      // marker, and still no tmux pane.
      const ensureRes = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/ensure`, { method: "POST" });
      expect(ensureRes.status).toBe(409);
      expect((await ensureRes.json()).error).toBe("resume_on_open_disabled");
      expect(tmuxHasSession(serve.tmuxSocket, tmuxName)).toBe(false);

      // The explicit Start action is unaffected: it launches the agent.
      const startRes = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/start`, { method: "POST" });
      expect(startRes.ok).toBeTruthy();
      await expect.poll(() => tmuxHasSession(serve.tmuxSocket, tmuxName), { timeout: 10_000 }).toBe(true);
    } finally {
      await serve.stop();
    }
  });
});
