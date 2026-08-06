// A seeded session/load replay does not wedge the structured turn tracker.
//
// fix/opencode-replay-settle-wedge: when a fresh structured view SEEDS an empty
// event store from the session/load history replay, the replayed historical
// user turn (`user_message_chunk` -> `UserPromptSent`) opens a turn the replay
// never closes with a `Stopped`, so `turnActive` used to stick at "waiting for
// model..." forever. The daemon now deterministically emits
// `Stopped { reason: "replay_settle" }` once `session/load` returns, retiring
// the phantom turn.
//
// Reproduced with the import flow (#2276), which is exactly a seeding load:
// import an existing transcript into a structured session (empty store, replay
// NOT suppressed) with the fake agent replaying a historical user turn + an
// assistant turn. Assert the replay renders AND the corrective replay_settle
// Stopped lands after it.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { spawnAoeServe } from "../helpers/aoeServe";

const SID = "cccccccc-dddd-eeee-ffff-000000000000";
const AGENT_REPLAY = "assistant reply from the seeded replay";
const USER_REPLAY = "historical user prompt that opens a phantom turn";
const PROJECT_SUBDIR = "wedge-project";

// Mirror src/session/capture.rs encode_claude_project_path over the canonical
// path: non-alphanumeric (except '-') becomes '-'.
function encodeClaudeProjectPath(canonicalPath: string): string {
  return canonicalPath.replace(/[^a-zA-Z0-9-]/g, "-");
}

test("seeded session/load replay retires its phantom turn (no wedge)", async ({}, testInfo) => {
  const serve = await spawnAoeServe({
    authMode: "none",
    acp: true,
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    extraEnv: { FAKE_ACP_LOAD_REPLAY: AGENT_REPLAY, FAKE_ACP_LOAD_REPLAY_USER: USER_REPLAY },
    seedFn: ({ home }) => {
      const projectDir = join(home, PROJECT_SUBDIR);
      mkdirSync(projectDir, { recursive: true });
      const encoded = encodeClaudeProjectPath(realpathSync(projectDir));
      const claudeProjects = join(home, ".claude", "projects", encoded);
      mkdirSync(claudeProjects, { recursive: true });
      const line = JSON.stringify({
        type: "user",
        cwd: projectDir,
        message: { role: "user", content: [{ type: "text", text: "seed prompt" }] },
      });
      writeFileSync(join(claudeProjects, `${SID}.jsonl`), `${line}\n`);
    },
  });

  const replayJson = async (sessionId: string): Promise<string> => {
    const res = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/acp/replay?since=0`);
    if (!res.ok) return "";
    return JSON.stringify((await res.json()).frames ?? []);
  };

  try {
    const projectDir = join(serve.home, PROJECT_SUBDIR);

    // Import the transcript into a structured session: a seeding session/load
    // with the replay NOT suppressed (empty store), which is the wedge path.
    const createRes = await fetch(`${serve.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectDir, tool: "claude", title: "wedge", import_acp_session_id: SID }),
    });
    expect(createRes.ok, `create failed: ${createRes.status}`).toBe(true);
    const sessionId: string = (await createRes.json()).id;

    // The replayed historical user + assistant turns render (seed not suppressed).
    await expect
      .poll(() => replayJson(sessionId), { timeout: 20_000, intervals: [200, 500, 1000] })
      .toContain(AGENT_REPLAY);
    expect(await replayJson(sessionId)).toContain(USER_REPLAY);

    // The deterministic corrective Stopped lands after the replay: without it the
    // replayed UserPromptSent would leave turnActive stuck. Its presence in the
    // event store is the proof the phantom turn was retired.
    await expect
      .poll(() => replayJson(sessionId), { timeout: 20_000, intervals: [200, 500, 1000] })
      .toContain("replay_settle");
  } finally {
    await serve.stop();
  }
});
