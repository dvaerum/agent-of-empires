import { describe, expect, it } from "vitest";
import { switchViewCopy } from "./acpKeepContext";

describe("switchViewCopy", () => {
  it("non-resumable agents restart fresh in both directions", () => {
    expect(switchViewCopy(true, false).body).toContain("fresh conversation");
    expect(switchViewCopy(false, false).body).toContain("restarts in a fresh terminal");
  });

  it("names no agent-specific resume flag when the terminal view keeps the conversation", () => {
    // The flag differs per agent (claude --resume, opencode --session), and the copy is shared by all of them.
    const body = switchViewCopy(false, true).body;
    expect(body).toContain("continues in the terminal");
    expect(body).toContain("resumes the same conversation");
    expect(body).not.toMatch(/--[a-z]/);
  });
});
