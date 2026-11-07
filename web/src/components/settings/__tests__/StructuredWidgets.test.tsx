// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ListField } from "../FormFields";
import { SchemaSection } from "../SchemaSection";
import type { SettingsFieldDescriptor, SettingsObjectField } from "../../../lib/types";

const SECTION = "plugin:acme.cron";
const RESOLVE_URL = "/api/plugins/acme.cron/settings/options/resolve";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      options: [
        { value: "claude-code", label: "Claude Code" },
        { value: "codex", label: "Codex" },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

const ALLOW = { policy: "allow" } as const;
const NONE = { rule: "none" } as const;

function descriptor(field: string, widget: SettingsFieldDescriptor["widget"]): SettingsFieldDescriptor {
  return {
    section: SECTION,
    field,
    category: "Plugins",
    label: field,
    description: "",
    web_write: { policy: "allow" },
    profile_overridable: false,
    validation: { rule: "none" },
    advanced: false,
    widget,
  } as SettingsFieldDescriptor;
}

const itemField = (field: string, widget: SettingsObjectField["widget"], required = false) =>
  ({ field, label: field, required, widget, validation: { rule: "str" } }) as SettingsObjectField;
const jobs = (...fields: SettingsObjectField[]) => [
  descriptor("jobs", { kind: "object_list", id_field: "id", fields }),
];

const CRON_JOBS = jobs(
  itemField("agent", { kind: "dynamic_select", source: "acp_agents" }, true),
  itemField("schedule", { kind: "cron" }, true),
);
const MULTI_JOBS = jobs(itemField("projects", { kind: "dynamic_multi_select", source: "projects" }));

function renderSection(schema: SettingsFieldDescriptor[], values: Record<string, unknown>) {
  const onSave = vi.fn().mockResolvedValue(true);
  const utils = render(<SchemaSection section={SECTION} schema={schema} values={values} onSaveField={onSave} />);
  const lastValue = async () => {
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return onSave.mock.calls.at(-1)![2];
  };
  return { onSave, lastValue, ...utils };
}

const job = (id: string, agent = "codex", schedule = "0 9 * * 1-5") => ({ id, agent, schedule });

describe("object_list", () => {
  it("keeps a new item as a local draft until its required fields are filled", async () => {
    const { onSave, lastValue } = renderSection(CRON_JOBS, { jobs: [] });
    fireEvent.click(screen.getByText("Add item"));
    await screen.findByText("Item 1");
    expect(onSave).not.toHaveBeenCalled();

    const cron = screen.getByPlaceholderText("0 9 * * 1-5");
    fireEvent.focus(cron);
    fireEvent.change(cron, { target: { value: "0 9 * * 1-5" } });
    fireEvent.blur(cron);
    await screen.findByText("Claude Code");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "claude-code" } });

    const value = (await lastValue()) as { id: string }[];
    expect(onSave.mock.calls.at(-1)!.slice(0, 2)).toEqual([SECTION, "jobs"]);
    expect(value).toHaveLength(1);
    expect(typeof value[0]!.id).toBe("string");
  });

  it("removes and reorders items", async () => {
    const removed = renderSection(CRON_JOBS, { jobs: [job("id-1")] });
    fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
    await waitFor(() => expect(removed.onSave).toHaveBeenCalledWith(SECTION, "jobs", []));
    removed.unmount();

    const moved = renderSection(CRON_JOBS, { jobs: [job("id-1"), job("id-2", "claude-code", "0 17 * * 1-5")] });
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]!);
    expect(((await moved.lastValue()) as { id: string }[]).map((it) => it.id)).toEqual(["id-2", "id-1"]);
  });

  it("re-syncs its working copy when persisted items change externally", async () => {
    const { rerender, onSave } = renderSection(CRON_JOBS, { jobs: [] });
    expect(screen.queryByText("Item 1")).toBeNull();
    rerender(
      <SchemaSection section={SECTION} schema={CRON_JOBS} values={{ jobs: [job("id-1")] }} onSaveField={onSave} />,
    );
    expect(await screen.findByText("Item 1")).toBeTruthy();
  });

  it("renders every item field widget kind and the top-level cron/dynamic_select", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.cron",
        field: "when",
        category: "Plugins",
        label: "When",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: { rule: "cron" },
        advanced: false,
        widget: { kind: "cron" },
      },
      {
        section: "plugin:acme.cron",
        field: "who",
        category: "Plugins",
        label: "Who",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: { rule: "str" },
        advanced: false,
        widget: { kind: "dynamic_select", source: "acp_agents" },
      },
      {
        section: "plugin:acme.cron",
        field: "rows",
        category: "Plugins",
        label: "Rows",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: NONE,
        advanced: false,
        widget: {
          kind: "object_list",
          id_field: "id",
          fields: [
            { field: "on", label: "On", required: false, widget: { kind: "toggle" }, validation: { rule: "bool" } },
            { field: "n", label: "N", required: false, widget: { kind: "number" }, validation: { rule: "range_i64" } },
            {
              field: "pick",
              label: "Pick",
              required: false,
              widget: { kind: "select", options: ["a", "b"] },
              validation: { rule: "one_of", options: ["a", "b"] },
            },
            { field: "note", label: "Note", required: false, widget: { kind: "text" }, validation: { rule: "str" } },
          ],
        },
      },
    ];

    render(
      <SchemaSection
        section="plugin:acme.cron"
        schema={schema}
        values={{ when: "0 9 * * 1-5", who: "codex", rows: [{ id: "r1", on: true, n: 2, pick: "a", note: "hi" }] }}
        onSaveField={onSave}
      />,
    );

    // Top-level cron + dynamic_select render, and the object_list item exposes
    // every nested widget kind.
    expect(screen.getByDisplayValue("0 9 * * 1-5")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByText("N")).toBeTruthy();
    expect(screen.getByText("Pick")).toBeTruthy();
    expect(screen.getByText("Note")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Claude Code")).toBeTruthy());
  });

  it("toggles a dynamic_multi_select item field and persists the chosen values as an array", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.cron",
        field: "jobs",
        category: "Plugins",
        label: "Jobs",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: NONE,
        advanced: false,
        widget: {
          kind: "object_list",
          id_field: "id",
          fields: [
            {
              field: "projects",
              label: "Projects",
              required: false,
              widget: { kind: "dynamic_multi_select", source: "projects" },
              validation: { rule: "str_list" },
            },
          ],
        },
      },
    ];
    render(
      <SchemaSection
        section="plugin:acme.cron"
        schema={schema}
        values={{ jobs: [{ id: "j1", projects: [] }] }}
        onSaveField={onSave}
      />,
    );

    // Options resolve from the host; toggling one persists it into the array.
    await waitFor(() => expect(screen.getByText("Claude Code")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Claude Code"));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [, field, value] = onSave.mock.calls.at(-1)!;
    expect(field).toBe("jobs");
    expect((value as { projects: string[] }[])[0]!.projects).toEqual(["claude-code"]);
  });

  it("multi-select shows an unavailable stored value and toggling off removes it", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.cron",
        field: "jobs",
        category: "Plugins",
        label: "Jobs",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: NONE,
        advanced: false,
        widget: {
          kind: "object_list",
          id_field: "id",
          fields: [
            {
              field: "projects",
              label: "Projects",
              required: false,
              widget: { kind: "dynamic_multi_select", source: "projects" },
              validation: { rule: "str_list" },
            },
          ],
        },
      },
    ];
    // "ghost" is not among the host-resolved options, so it renders as
    // unavailable but is preserved; "claude-code" is selected and gets removed.
    render(
      <SchemaSection
        section="plugin:acme.cron"
        schema={schema}
        values={{ jobs: [{ id: "j1", projects: ["claude-code", "ghost"] }] }}
        onSaveField={onSave}
      />,
    );

    await waitFor(() => expect(screen.getByText("ghost (unavailable)")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Claude Code"));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [, , value] = onSave.mock.calls.at(-1)!;
    expect((value as { projects: string[] }[])[0]!.projects).toEqual(["ghost"]);
  });

  it("multi-select resolves depends_on sibling values from the item", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.cron",
        field: "jobs",
        category: "Plugins",
        label: "Jobs",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: NONE,
        advanced: false,
        widget: {
          kind: "object_list",
          id_field: "id",
          fields: [
            {
              field: "agent",
              label: "Agent",
              required: false,
              widget: { kind: "dynamic_select", source: "acp_agents" },
              validation: { rule: "str" },
            },
            {
              field: "models",
              label: "Models",
              required: false,
              widget: { kind: "dynamic_multi_select", source: "acp_models", depends_on: ["agent"] },
              validation: { rule: "str_list" },
            },
          ],
        },
      },
    ];
    render(
      <SchemaSection
        section="plugin:acme.cron"
        schema={schema}
        values={{ jobs: [{ id: "j1", agent: "opencode", models: [] }] }}
        onSaveField={onSave}
      />,
    );
    // The multi-select resolved its options using the sibling `agent` value.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/plugins/acme.cron/settings/options/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.getByText("Models")).toBeTruthy();
  });

  it("renders a top-level password setting as a masked input", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.bridge",
        field: "token",
        category: "Plugins",
        label: "Token",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: NONE,
        advanced: false,
        widget: { kind: "password" },
      },
    ];
    const { container } = render(
      <SchemaSection section="plugin:acme.bridge" schema={schema} values={{ token: "s3cr3t" }} onSaveField={onSave} />,
    );

    const input = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // Masked by default (type=password) yet carrying the stored value.
    expect(input!.value).toBe("s3cr3t");
  });

  it("renders an object_list password item field as a masked input", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.bridge",
        field: "servers",
        category: "Plugins",
        label: "Servers",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: NONE,
        advanced: false,
        widget: {
          kind: "object_list",
          id_field: "id",
          fields: [
            { field: "token", label: "Token", required: false, widget: { kind: "password" }, validation: { rule: "str" } },
          ],
        },
      },
    ];
    const { container } = render(
      <SchemaSection
        section="plugin:acme.bridge"
        schema={schema}
        values={{ servers: [{ id: "s1", token: "hunter2" }] }}
        onSaveField={onSave}
      />,
    );

    const input = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.value).toBe("hunter2");
  });

  it("resolves a sessions dynamic_select from the host and renders the labels", async () => {
    // The sessions source resolves live sessions to {value:<id>, label:"<title> (<id>)"}.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        options: [{ value: "abc123", label: "Backend work (abc123)" }],
      }),
    });
    const onSave = vi.fn().mockResolvedValue(true);
    const schema: SettingsFieldDescriptor[] = [
      {
        section: "plugin:acme.bridge",
        field: "session_id",
        category: "Plugins",
        label: "Session",
        description: "",
        web_write: ALLOW,
        profile_overridable: false,
        validation: { rule: "str" },
        advanced: false,
        widget: { kind: "dynamic_select", source: "sessions" },
      },
    ];
    render(
      <SchemaSection section="plugin:acme.bridge" schema={schema} values={{ session_id: "" }} onSaveField={onSave} />,
    );

    // Posted the `sessions` source to the resolver and rendered the host label.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/plugins/acme.bridge/settings/options/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as { body: string }).body);
    expect(body.source).toBe("sessions");
    await waitFor(() => expect(screen.getByText("Backend work (abc123)")).toBeTruthy());
  });
});

describe("dynamic_multi_select", () => {
  it.each([
    [[], ["claude-code"]],
    [["claude-code", "ghost"], ["ghost"]],
  ])("toggling Claude Code on %j persists %j, keeping unavailable values", async (projects, expected) => {
    const { lastValue } = renderSection(MULTI_JOBS, { jobs: [{ id: "j1", projects }] });
    await screen.findByText("Claude Code");
    if (projects.includes("ghost")) expect(screen.getByText("ghost (unavailable)")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Claude Code"));
    expect(((await lastValue()) as { projects: string[] }[])[0]!.projects).toEqual(expected);
  });

  it("resolves depends_on from sibling item values", async () => {
    const schema = jobs(
      itemField("agent", { kind: "dynamic_select", source: "acp_agents" }),
      itemField("models", { kind: "dynamic_multi_select", source: "acp_models", depends_on: ["agent"] }),
    );
    renderSection(schema, { jobs: [{ id: "j1", agent: "opencode", models: [] }] });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) => url === RESOLVE_URL && String(init.body).includes("opencode")),
      ).toBe(true),
    );
    expect(screen.getByText("models")).toBeTruthy();
  });
});

describe("list (string_list item field)", () => {
  it("adds and removes freeform entries", async () => {
    const schema = jobs(itemField("match", { kind: "list" }, true));
    const { lastValue } = renderSection(schema, { jobs: [{ id: "j1", match: ["a/*"] }] });
    expect(screen.getByText("a/*")).toBeTruthy();

    fireEvent.click(screen.getByText("+ Add"));
    expect(screen.getByLabelText("match")).toBe(screen.getByRole("textbox"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "b/*" } });
    fireEvent.click(screen.getByText("Add"));
    expect(((await lastValue()) as { match: string[] }[])[0]!.match).toEqual(["a/*", "b/*"]);
  });

  it("removes one entry while another remains", async () => {
    const schema = jobs(itemField("match", { kind: "list" }, true));
    const { lastValue } = renderSection(schema, { jobs: [{ id: "j1", match: ["a/*", "b/*"] }] });
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]!);
    expect(((await lastValue()) as { match: string[] }[])[0]!.match).toEqual(["b/*"]);
  });

  it("keeps a cleared required list local, but persists an empty optional list", async () => {
    const required = renderSection(jobs(itemField("match", { kind: "list" }, true)), {
      jobs: [{ id: "j1", match: ["a/*"] }],
    });
    fireEvent.click(screen.getByTitle(/^Remove /));
    await waitFor(() => expect(screen.queryByText("a/*")).toBeNull());
    expect(required.onSave).not.toHaveBeenCalled();
    required.unmount();

    const optional = renderSection(jobs(itemField("match", { kind: "list" })), {
      jobs: [{ id: "j1", match: ["a/*"] }],
    });
    fireEvent.click(screen.getByTitle(/^Remove /));
    expect(((await optional.lastValue()) as { match: string[] }[])[0]!.match).toEqual([]);
  });
});

describe("ListField editing", () => {
  const schema = [descriptor("tags", { kind: "list" })];

  it("edits an entry in place, keeping its position", async () => {
    const { lastValue } = renderSection(schema, { tags: ["a", "b", "c"] });
    fireEvent.click(screen.getByTitle("Edit b"));
    const input = screen.getByDisplayValue("b");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await lastValue()).toEqual(["a", "x", "c"]);
  });

  it("cancels an edit with Escape without saving", () => {
    const { onSave } = renderSection(schema, { tags: ["a"] });
    fireEvent.click(screen.getByTitle("Edit a"));
    const input = screen.getByDisplayValue("a");
    fireEvent.change(input, { target: { value: "z" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("a")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the remove button visible without hover", () => {
    renderSection(schema, { tags: ["a"] });
    expect(screen.getByTitle("Remove a").className).not.toContain("opacity-0");
  });
});

describe("ListField with a controlled parent", () => {
  function Controlled({ initial, delayed = false }: { initial: string[]; delayed?: boolean }) {
    const [items, setItems] = useState(initial);
    return (
      <ListField
        label="tags"
        items={items}
        onChange={(next) => (delayed ? setTimeout(() => setItems(next), 0) : setItems(next))}
      />
    );
  }
  const rows = () => screen.getAllByTitle(/^Edit /).map((b) => b.getAttribute("title")!.slice(5));

  it.each([
    ["middle", false],
    ["middle, parent updates asynchronously", true],
  ])("keeps editing the same entry after an earlier one is removed (%s)", async (_name, delayed) => {
    render(<Controlled initial={["a", "b", "c"]} delayed={delayed} />);
    fireEvent.click(screen.getByTitle("Edit b"));
    fireEvent.change(screen.getByDisplayValue("b"), { target: { value: "x" } });
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]!);
    await waitFor(() => expect(rows()).toEqual(["c"]));
    const input = screen.getByDisplayValue("x");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(rows()).toEqual(["x", "c"]));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps editing the last entry after an earlier one is removed", async () => {
    render(<Controlled initial={["a", "b", "c"]} />);
    fireEvent.click(screen.getByTitle("Edit c"));
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]!);
    fireEvent.change(await screen.findByDisplayValue("c"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("x")).toBeTruthy());
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.queryByText("c")).toBeNull();
  });

  it("edits the right one of two identical entries after an earlier removal", async () => {
    render(<Controlled initial={["a", "b", "b"]} />);
    fireEvent.click(screen.getAllByTitle("Edit b")[0]!);
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]!);
    fireEvent.change(await screen.findByDisplayValue("b"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(rows()).toEqual(["x", "b"]));
  });

  it("closes the editor when an equal-valued removal makes the edited entry ambiguous", async () => {
    render(<Controlled initial={["a", "b", "b", "b"]} />);
    fireEvent.click(screen.getAllByTitle("Edit b")[1]!);
    fireEvent.click(screen.getAllByTitle(/^Remove /)[1]!);
    await waitFor(() => expect(rows()).toEqual(["a", "b", "b"]));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("closes the editor when the parent drops the edited entry", () => {
    const noop = vi.fn();
    const { rerender } = render(<ListField label="tags" items={["a", "b"]} onChange={noop} />);
    fireEvent.click(screen.getByTitle("Edit b"));
    expect(screen.getByRole("textbox")).toBeTruthy();
    rerender(<ListField label="tags" items={["a"]} onChange={noop} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("+ Add")).toBeTruthy();
  });

  it("ignores Enter that confirms an IME composition", () => {
    const onChange = vi.fn();
    render(<ListField label="tags" items={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText("+ Add"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "か" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    // Safari reports the composition-ending Enter with isComposing false and keyCode 229.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["か"]);
  });
});
