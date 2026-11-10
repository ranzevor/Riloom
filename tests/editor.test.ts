import { afterEach, describe, expect, it } from "vitest";
import { Editor, type Execute } from "../apps/studio/src/editor.js";
import {
  RiloomError,
  type Parameter,
} from "../packages/contracts/dist/index.js";
import { fixture, parameter } from "./helpers.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
let test: ReturnType<typeof fixture> | undefined;
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  test?.dispose();
  test = undefined;
});
function setup(execute?: (base: Execute) => Execute) {
  const f = (test = fixture()),
    storage = memoryStorage();
  const base: Execute = async (input) => f.execute(input);
  const editor = new Editor(
    execute ? execute(base) : base,
    f.store.workspaceId,
    storage,
  );
  editors.push(editor);
  return { f, editor, storage, base };
}
describe("Studio editing", () => {
  it("creates, saves a parameter, applies and restores after reopening", async () => {
    const { editor, f, storage, base } = setup();
    await editor.create("工作台工程", "studio.riloom");
    editor.addParameter();
    const id = editor.getSnapshot().selected!;
    editor.updateParameter(id, { name: "呼吸", min: 0, max: 1, value: 0.5 });
    await editor.save();
    const projectId = editor.getSnapshot().project!.model.projectId;
    expect(f.project(projectId).revision).toBe(0);
    const reopened = new Editor(base, f.store.workspaceId, storage);
    editors.push(reopened);
    await reopened.initialize();
    expect(reopened.getSnapshot().parameters[0]).toMatchObject({
      name: "呼吸",
      value: 0.5,
    });
    await reopened.apply();
    expect(f.project(projectId).revision).toBe(1);
    const fresh = new Editor(base, f.store.workspaceId, storage);
    editors.push(fresh);
    await fresh.initialize();
    expect(fresh.getSnapshot().parameters).toEqual(
      f.project(projectId).model.parameters,
    );
    await fresh.navigate("undo");
    expect(fresh.getSnapshot().parameters).toEqual([]);
    await fresh.navigate("redo");
    expect(fresh.getSnapshot().parameters[0]!.name).toBe("呼吸");
  });
  it("saves subsequent edits after an in-flight save finishes", async () => {
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    const { editor, f } = setup((base) => async (input) => {
      if (input.command === "riloom.project.saveDraft" && !delayed) {
        delayed = true;
        reached();
        await barrier;
      }
      return base(input);
    });
    await editor.create("排队工程", "queue.riloom");
    editor.addParameter();
    const save = editor.save();
    await waiting;
    editor.updateParameter(editor.getSnapshot().selected!, {
      name: "后续修改",
    });
    release();
    await save;
    expect(editor.getSnapshot().savedGeneration).toBe(
      editor.getSnapshot().generation,
    );
    const drafts = f.store
      .openProject(editor.getSnapshot().project!.model.projectId)
      .read((tx) => tx.drafts());
    expect((drafts[0]!.changes[0] as { after: Parameter }).after.name).toBe(
      "后续修改",
    );
    expect(drafts[0]!.draftVersion).toBe(2);
  });
  it("retries an unresolved apply with the same request and keeps editing locked", async () => {
    let interrupted = false;
    const { editor, f } = setup((base) => async (input) => {
      const result = await base(input);
      if (input.command === "riloom.project.apply" && !interrupted) {
        interrupted = true;
        throw new RiloomError("EFFECT_UNRESOLVED", "连接中断");
      }
      return result;
    });
    await editor.create("重试工程", "retry.riloom");
    editor.addParameter();
    await editor.apply();
    expect(editor.getSnapshot().rechecking).toBe(true);
    const parameters = editor.getSnapshot().parameters;
    editor.updateParameter(parameters[0]!.id, { name: "不应写入" });
    expect(editor.getSnapshot().parameters).toEqual(parameters);
    await editor.apply();
    expect(editor.getSnapshot().rechecking).toBe(false);
    expect(
      f.project(editor.getSnapshot().project!.model.projectId).revision,
    ).toBe(1);
  });
  it("keeps an older draft when another entry edits the model and explicitly rebases", async () => {
    const { editor, f } = setup();
    await editor.create("并发工程", "concurrent.riloom");
    editor.addParameter();
    await editor.save();
    const projectId = editor.getSnapshot().project!.model.projectId;
    f.apply(projectId, [
      { type: "addParameter", after: parameter("other", "外部参数") },
    ]);
    await editor.refreshCurrent();
    expect(editor.getSnapshot().parameters).toHaveLength(1);
    expect(editor.getSnapshot().error).toContain("草稿已保留");
    await editor.apply();
    expect(editor.getSnapshot().error).toBeTruthy();
    await editor.rebase();
    await editor.apply();
    expect(editor.getSnapshot().error).toBeNull();
    expect(f.project(projectId).model.parameters).toHaveLength(2);
  });
  it("retains invalid input for correction and applies after it is repaired", async () => {
    const { editor, f } = setup();
    await editor.create("校验工程", "validation.riloom");
    editor.addParameter();
    const id = editor.getSnapshot().selected!;
    editor.updateParameter(id, { value: 3 });
    await editor.save();
    expect(editor.getSnapshot().parameters[0]!.value).toBe(3);
    expect(editor.getSnapshot().error).toContain("取值范围");
    expect(
      f.project(editor.getSnapshot().project!.model.projectId).revision,
    ).toBe(0);
    editor.updateParameter(id, { value: 0.5 });
    await editor.apply();
    expect(editor.getSnapshot().error).toBeNull();
    expect(editor.getSnapshot().project!.revision).toBe(1);
  });

  it("keeps a cleared numeric field editable until corrected", async () => {
    const { editor } = setup();
    await editor.create("数值工程", "numeric.riloom");
    editor.addParameter();
    await editor.apply();
    const id = editor.getSnapshot().selected!;
    editor.updateParameter(id, { value: NaN });
    expect(() => editor.changes()).not.toThrow();
    await editor.save();
    expect(editor.getSnapshot().error).toBeTruthy();
    editor.updateParameter(id, { value: 0.25 });
    await editor.apply();
    expect(editor.getSnapshot().project!.revision).toBe(2);
  });
  it("discards a delayed refresh from a previously opened project", async () => {
    let release!: () => void;
    let delayed = false;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let target = "";
    const { editor, f } = setup((base) => async (input) => {
      const result = await base(input);
      if (
        delayed &&
        input.command === "riloom.project.get" &&
        input.projectId === target
      ) {
        delayed = false;
        await barrier;
      }
      return result;
    });
    await editor.create("第一工程", "first.riloom");
    target = editor.getSnapshot().project!.model.projectId;
    const second = f.create("第二工程", "second.riloom");
    delayed = true;
    const refresh = editor.refreshCurrent();
    await editor.open(second.projectId);
    release();
    await refresh;
    expect(editor.getSnapshot().project!.model.projectId).toBe(
      second.projectId,
    );
  });
  it("settles an in-flight save before rebasing onto external changes", async () => {
    let release!: () => void, reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let delayed = false;
    const { editor, f } = setup((base) => async (input) => {
      if (input.command === "riloom.project.saveDraft" && !delayed) {
        delayed = true;
        reached();
        await barrier;
      }
      return base(input);
    });
    await editor.create("重新准备", "rebase.riloom");
    editor.addParameter();
    const saving = editor.save();
    await waiting;
    const projectId = editor.getSnapshot().project!.model.projectId;
    f.apply(projectId, [{ type: "addParameter", after: parameter("other") }]);
    const rebase = editor.rebase();
    release();
    await saving;
    await rebase;
    await editor.apply();
    expect(f.project(projectId).model.parameters).toHaveLength(2);
    expect(editor.getSnapshot().error).toBeNull();
  });
});
