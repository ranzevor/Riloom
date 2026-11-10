import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Draft } from "../packages/contracts/dist/index.js";
import { fixture, parameter, request, success } from "./helpers.js";

let test: ReturnType<typeof fixture> | undefined;
afterEach(() => {
  test?.dispose();
  test = undefined;
});
const setup = () => (test = fixture());
describe("durable project editing", () => {
  it("creates once and returns the original receipt after restart", () => {
    const f = setup(),
      created = f.create();
    f.reopen();
    expect(f.execute(created.command)).toEqual(created.receipt);
    expect(f.project(created.projectId).revision).toBe(0);
    expect(() =>
      f.execute({
        ...created.command,
        arguments: { ...created.command.arguments, name: "另一工程" },
      }),
    ).toThrow("请求标识已用于");
  });
  it("preserves an existing directory", () => {
    const f = setup(),
      target = path.join(f.directory, "sample.riloom");
    mkdirSync(target);
    writeFileSync(path.join(target, "original.txt"), "keep");
    expect(() => f.create()).toThrow("目标目录已包含内容");
    expect(readFileSync(path.join(target, "original.txt"), "utf8")).toBe(
      "keep",
    );
  });
  it("saves without applying, applies atomically once and reloads", () => {
    const f = setup(),
      { projectId } = f.create();
    const draft = success(
      f.save(projectId, [{ type: "addParameter", after: parameter() }]),
    ).result.draft as Draft;
    f.reopen();
    const candidate = f.prepare(projectId, draft);
    expect(f.project(projectId).model.parameters).toEqual([]);
    const command = f.applyRequest(projectId, draft, candidate);
    const receipt = success(f.execute(command));
    expect(receipt.beforeRevision).toBe(0);
    expect(receipt.afterRevision).toBe(1);
    f.reopen();
    expect(f.execute(command)).toEqual(receipt);
    expect(f.project(projectId).model.parameters).toEqual([parameter()]);
    const result = f.execute(
      request(
        "riloom.project.getDraft",
        { draftId: draft.draftId },
        { projectId },
      ),
    );
    expect(result.result.draft).toMatchObject({
      draftStatus: "applied",
      draftVersion: 2,
    });
    expect(
      f.store.openProject(projectId).read((tx) => tx.events(0, 100)),
    ).toHaveLength(3);
  });
  it("rolls back a failing change group and keeps its failure receipt", () => {
    const f = setup(),
      { projectId } = f.create();
    const input = request(
      "riloom.project.saveDraft",
      {
        draftId: "bad",
        editorId: "editor",
        baseRevision: 0,
        baseStateHash: f.project(projectId).stateHash,
        editGeneration: 1,
        changes: [
          { type: "addParameter", after: parameter() },
          { type: "addParameter", after: parameter() },
        ],
      },
      { projectId, expectedDraftVersion: 0 },
    );
    const receipt = f.execute(input);
    expect(receipt).toMatchObject({
      status: "failed",
      error: { code: "REVISION_CONFLICT" },
    });
    expect(f.project(projectId).revision).toBe(0);
    expect(
      f.store.openProject(projectId).read((tx) => tx.draft("bad")),
    ).toBeNull();
    f.reopen();
    expect(f.execute(input)).toEqual(receipt);
  });
  it("rejects concurrent draft saves and a candidate with a stale model", () => {
    const f = setup(),
      { projectId } = f.create();
    const first = success(
      f.save(projectId, [{ type: "addParameter", after: parameter() }]),
    ).result.draft as Draft;
    const candidate = f.prepare(projectId, first),
      stale = f.applyRequest(projectId, first, candidate);
    const saved = success(
      f.save(
        projectId,
        first.changes,
        { expectedDraftVersion: 1 },
        { draftId: first.draftId, editorId: first.editorId, editGeneration: 2 },
      ),
    ).result.draft as Draft;
    expect(saved.draftVersion).toBe(2);
    expect(
      f.save(
        projectId,
        first.changes,
        { expectedDraftVersion: 1 },
        { draftId: first.draftId, editorId: first.editorId, editGeneration: 3 },
      ),
    ).toMatchObject({ status: "failed", error: { code: "REVISION_CONFLICT" } });
    f.apply(projectId, [{ type: "addParameter", after: parameter("other") }]);
    expect(f.execute(stale)).toMatchObject({
      status: "failed",
      error: { code: "REVISION_CONFLICT" },
    });
    expect(
      f.project(projectId).model.parameters.map((item) => item.id),
    ).toEqual(["other"]);
  });
  it("rejects late saves after a draft is discarded", () => {
    const f = setup(),
      { projectId } = f.create();
    const draft = success(
      f.save(projectId, [{ type: "addParameter", after: parameter() }]),
    ).result.draft as Draft;
    success(
      f.execute(
        request(
          "riloom.project.discardDraft",
          { draftId: draft.draftId },
          { projectId, expectedDraftVersion: 1 },
        ),
      ),
    );
    expect(
      f.save(
        projectId,
        draft.changes,
        { expectedDraftVersion: 1 },
        { draftId: draft.draftId, editorId: draft.editorId, editGeneration: 2 },
      ),
    ).toMatchObject({ status: "failed", error: { code: "REVISION_CONFLICT" } });
  });
  it("supports shared undo, redo and invalidates a replaced history branch", () => {
    const f = setup(),
      { projectId } = f.create();
    f.apply(projectId, [{ type: "addParameter", after: parameter() }]);
    const navigate = (direction: "undo" | "redo") => {
      const state = f.project(projectId);
      return success(
        f.execute(
          request(
            "riloom.project." + direction,
            {
              undoGroupId:
                direction === "undo" ? state.undoGroupId : state.redoGroupId,
            },
            {
              projectId,
              expectedRevision: state.revision,
              expectedStateHash: state.stateHash,
              expectedHistoryVersion: state.historyVersion,
            },
          ),
        ),
      );
    };
    navigate("undo");
    expect(f.project(projectId).model.parameters).toEqual([]);
    navigate("redo");
    expect(f.project(projectId).model.parameters).toEqual([parameter()]);
    navigate("undo");
    f.apply(projectId, [{ type: "addParameter", after: parameter("branch") }]);
    expect(f.project(projectId).redoGroupId).toBeNull();
    f.reopen();
    expect(f.project(projectId).model.parameters[0]!.id).toBe("branch");
  });
  it("invalidates cursors when a collection or service generation changes", () => {
    const f = setup();
    f.create("一", "one.riloom");
    f.create("二", "two.riloom");
    const input = request(
      "riloom.project.list",
      { limit: 1 },
      { workspaceId: f.store.workspaceId },
    );
    const first = f.execute(input).result;
    expect(first.nextCursor).toBeTypeOf("string");
    const next = {
      ...input,
      arguments: { limit: 1, cursor: first.nextCursor },
    };
    expect(f.execute(next).result.items).toHaveLength(1);
    f.reopen();
    expect(() => f.execute(next)).toThrow("列表已经变化");
    const again = f.execute(input).result.nextCursor;
    f.create("三", "three.riloom");
    expect(() =>
      f.execute({ ...input, arguments: { limit: 1, cursor: again } }),
    ).toThrow("列表已经变化");
  });
  it("detects corrupt state and preserves the file", () => {
    const f = setup(),
      { projectId } = f.create();
    f.apply(projectId, [{ type: "addParameter", after: parameter() }]);
    f.reopen();
    const filename = path.join(f.directory, "sample.riloom", "project.sqlite");
    const db = new DatabaseSync(filename);
    db.prepare("UPDATE objects SET data=?").run("{");
    db.close();
    expect(() => f.project(projectId)).toThrow("工程记录无法读取");
    expect(existsSync(filename)).toBe(true);
  });
  it.each([
    "create-intent",
    "project-ready",
    "project-published",
    "before-project-commit",
  ])("recovers a terminated process at %s", (point) => {
    const f = setup();
    let projectId: string | undefined;
    let command: ReturnType<typeof request> | undefined;
    if (point === "before-project-commit") {
      projectId = f.create().projectId;
      const draft = success(
        f.save(projectId, [{ type: "addParameter", after: parameter() }]),
      ).result.draft as Draft;
      command = f.applyRequest(projectId, draft, f.prepare(projectId, draft));
    }
    f.close();
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/crash-worker.mjs", import.meta.url)),
        f.directory,
        f.lockDirectory,
        point,
        command ? JSON.stringify(command) : "",
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stdout + child.stderr).toContain("checkpoint:" + point);
    f.reopen();
    if (projectId) {
      expect(f.project(projectId).revision).toBe(0);
      expect(
        f.store.openProject(projectId).read((tx) => tx.drafts()[0]),
      ).toMatchObject({ draftStatus: "editing", draftVersion: 1 });
      expect(
        f.store
          .openProject(projectId)
          .read((tx) => tx.receipt(command!.requestId)),
      ).toBeNull();
      success(f.execute(command!));
      expect(f.project(projectId).revision).toBe(1);
    } else {
      const result = f.store.receipt("crash-create");
      expect(result).not.toBeNull();
      if (point === "create-intent") expect(result!.status).toBe("failed");
      else {
        expect(result!.status).toBe("succeeded");
        expect(f.project(result!.result.projectId as string).revision).toBe(0);
      }
    }
  });
});
