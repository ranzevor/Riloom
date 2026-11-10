import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { Editor } from "../apps/studio/src/editor.js";
import { RiloomError } from "../packages/contracts/dist/index.js";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodePng,
  inspectComponentRgba,
} from "../packages/image/dist/index.js";
import { applyChanges, orderedDrawItems } from "../packages/core/dist/index.js";
import { hashValue } from "../packages/application/dist/index.js";
import { sampleComposite, hitTest } from "../packages/renderer/dist/index.js";
import type {
  Asset,
  Candidate,
  Change,
  Draft,
  DrawItem,
  ProjectModel,
} from "../packages/contracts/dist/index.js";
import { fixture, parameter, request, success } from "./helpers.js";

const bytes = Buffer.from([
  255, 0, 0, 255, 10, 20, 30, 1, 101, 102, 103, 0, 0, 0, 255, 128,
]);
function png() {
  return PNG.sync.write(
    Object.assign(new PNG(), { width: 2, height: 2, data: bytes, gamma: 0 }),
  );
}
const opened: ReturnType<typeof fixture>[] = [];
function setup() {
  const test = fixture();
  opened.push(test);
  return { test, projectId: test.create().projectId };
}
afterEach(() => {
  for (const test of opened.splice(0)) test.dispose();
});
function imported(test: ReturnType<typeof fixture>, projectId: string) {
  const input = request(
    "riloom.asset.import",
    { name: "彩色图层", pngBase64: png().toString("base64") },
    { projectId, expectedDraftVersion: 0 },
  );
  return { input, receipt: success(test.execute(input)) };
}
function applyImported(test: ReturnType<typeof fixture>, projectId: string) {
  const result = imported(test, projectId);
  const state = test.project(projectId);
  success(
    test.execute(
      request(
        "riloom.project.apply",
        {
          draftId: (result.receipt.result.candidate as Candidate).draftId,
          candidateId: (result.receipt.result.candidate as Candidate)
            .candidateId,
        },
        {
          projectId,
          expectedRevision: state.revision,
          expectedStateHash: state.stateHash,
          expectedDraftVersion: 1,
        },
      ),
    ),
  );
  return result;
}
describe("PNG and pixel preservation", () => {
  it("keeps low alpha and invisible RGB at the full source frame", () => {
    const image = decodePng(png());
    expect(image.pixels).toEqual(bytes);
    expect(image.analysis).toEqual({
      paintedPixels: 3,
      partialAlphaPixels: 2,
      hiddenRgbPixels: 1,
      alphaBounds: { x: 0, y: 0, width: 2, height: 2 },
    });
  });
  it("keeps 16-bit samples in little endian without reducing precision", () => {
    const samples = new Uint16Array([65535, 321, 12345, 1, 123, 456, 789, 0]);
    const image = PNG.sync.write(
      Object.assign(new PNG(), {
        width: 2,
        height: 1,
        data: Buffer.from(samples.buffer),
        gamma: 0,
      }),
      { bitDepth: 16 },
    );
    const result = decodePng(image);
    expect(result.bitDepth).toBe(16);
    expect([
      ...new Uint16Array(
        result.pixels.buffer,
        result.pixels.byteOffset,
        samples.length,
      ),
    ]).toEqual([...samples]);
  });
  it("rejects a broken CRC and mismatched dimensions", () => {
    const broken = Buffer.from(png());
    broken[broken.length - 1]! ^= 1;
    expect(() => decodePng(broken)).toThrow();
    expect(() =>
      inspectComponentRgba({
        width: 2,
        height: 2,
        bitDepth: 8,
        data: new Uint8Array(3),
      }),
    ).toThrow();
  });
  it("retains transparent images and rejects a non-sRGB gamma", () => {
    const clear = PNG.sync.write(
      Object.assign(new PNG(), {
        width: 1,
        height: 1,
        data: Buffer.from([1, 2, 3, 0]),
        gamma: 0,
      }),
    );
    expect(decodePng(clear).analysis.alphaBounds).toBeNull();
    const other = PNG.sync.write(
      Object.assign(new PNG(), {
        width: 1,
        height: 1,
        data: Buffer.from([1, 2, 3, 255]),
        gamma: 1,
      }),
    );
    expect(() => decodePng(other)).toThrow("伽马");
  });
});
describe("asset lifetime", () => {
  it("imports to a draft, applies once, reopens and keeps original bytes", () => {
    const { test, projectId } = setup();
    const { input, receipt } = applyImported(test, projectId);
    expect(test.execute(input)).toEqual(receipt);
    test.reopen();
    const state = test.project(projectId),
      asset = state.model.assets![0]!;
    expect(state.model.drawItems![0]!.name).toBe("彩色图层");
    expect(
      Buffer.from(
        test.store
          .openProject(projectId)
          .read((tx) => tx.readBlob(asset.source)),
      ),
    ).toEqual(png());
    expect(
      Buffer.from(
        test.store
          .openProject(projectId)
          .read((tx) => tx.readBlob(asset.pixels)),
      ),
    ).toEqual(bytes);
  });
  it("preserves image resources through undo, backup, restore and redo", () => {
    const { test, projectId } = setup();
    applyImported(test, projectId);
    let state = test.project(projectId);
    success(
      test.execute(
        request(
          "riloom.project.undo",
          { undoGroupId: state.undoGroupId },
          {
            projectId,
            expectedRevision: state.revision,
            expectedStateHash: state.stateHash,
            expectedHistoryVersion: state.historyVersion,
          },
        ),
      ),
    );
    state = test.project(projectId);
    expect(state.model.drawItems).toHaveLength(0);
    const backup = success(
      test.execute(
        request(
          "riloom.project.backup",
          {
            projectId,
            expectedRevision: state.revision,
            expectedStateHash: state.stateHash,
            expectedStorageGeneration: state.storageGeneration,
          },
          { workspaceId: test.store.workspaceId },
        ),
      ),
    ).result.backup as { backupId: string };
    const plan = success(
      test.execute(
        request(
          "riloom.project.prepareRestore",
          { backupId: backup.backupId },
          { workspaceId: test.store.workspaceId },
        ),
      ),
    ).result.plan as { expectedProject: object };
    success(
      test.execute(
        request(
          "riloom.project.restore",
          {
            backupId: backup.backupId,
            directory: "recovered.riloom",
            expectedProject: plan.expectedProject,
          },
          { workspaceId: test.store.workspaceId },
        ),
      ),
    );
    state = test.project(projectId);
    success(
      test.execute(
        request(
          "riloom.project.redo",
          { undoGroupId: state.redoGroupId },
          {
            projectId,
            expectedRevision: state.revision,
            expectedStateHash: state.stateHash,
            expectedHistoryVersion: state.historyVersion,
            expectedStorageGeneration: state.storageGeneration,
          },
        ),
      ),
    );
    const asset = test.project(projectId).model.assets![0]!;
    expect(
      Buffer.from(
        test.store
          .openProject(projectId)
          .read((tx) => tx.readBlob(asset.pixels)),
      ),
    ).toEqual(bytes);
  });
  it("keeps a failed import from changing the model or registering resources", () => {
    const { test, projectId } = setup(),
      before = test.project(projectId);
    const failed = test.execute(
      request(
        "riloom.asset.import",
        { name: "损坏", pngBase64: "AAAAAAAAAAAA" },
        { projectId, expectedDraftVersion: 0 },
      ),
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT" },
    });
    expect(test.project(projectId).model).toEqual(before.model);
    expect(
      test.store.openProject(projectId).read((tx) => tx.blobs()),
    ).toHaveLength(0);
  });
  it("resumes the same import after failure at the transaction boundary", () => {
    const { test, projectId } = setup();
    const input = request(
      "riloom.asset.import",
      { name: "中断", pngBase64: png().toString("base64") },
      { projectId, expectedDraftVersion: 0 },
    );
    test.reopen({
      checkpoint(point) {
        if (point === "before-project-commit")
          throw new Error("commit interrupted");
      },
    });
    expect(() => test.execute(input)).toThrow("commit interrupted");
    test.reopen();
    expect(
      test.store.openProject(projectId).read((tx) => tx.blobs()),
    ).toHaveLength(0);
    expect(test.project(projectId).model.assets).toHaveLength(0);
    const receipt = success(test.execute(input));
    expect(test.execute(input)).toEqual(receipt);
    expect(
      test.store.openProject(projectId).read((tx) => tx.blobs()),
    ).toHaveLength(2);
  });
  it("rejects stale draft imports and reused request inputs", () => {
    const { test, projectId } = setup(),
      result = imported(test, projectId);
    expect(() =>
      test.execute({
        ...result.input,
        arguments: { ...result.input.arguments, name: "另一个" },
      }),
    ).toThrow();
    const candidate = result.receipt.result.candidate as Candidate;
    const failed = test.execute(
      request(
        "riloom.asset.import",
        { ...result.input.arguments, draftId: candidate.draftId },
        { projectId, expectedDraftVersion: 0 },
      ),
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "REVISION_CONFLICT" },
    });
    expect(
      test.store.openProject(projectId).read((tx) => tx.blobs()),
    ).toHaveLength(2);
  });
  it("rejects modified resource content during backup", () => {
    const { test, projectId } = setup();
    applyImported(test, projectId);
    const state = test.project(projectId),
      digest = state.model.assets![0]!.pixels.hash.digest;
    writeFileSync(
      path.join(test.directory, "sample.riloom", "assets", digest),
      Buffer.alloc(bytes.length),
    );
    const result = test.execute(
      request(
        "riloom.project.backup",
        {
          projectId,
          expectedRevision: state.revision,
          expectedStateHash: state.stateHash,
          expectedStorageGeneration: state.storageGeneration,
        },
        { workspaceId: test.store.workspaceId },
      ),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "DATA_CORRUPT" },
    });
  });
  it("upgrades an old parameter-only database and restores its exact model by undo", () => {
    const { test, projectId } = setup();
    const directory = path.join(test.directory, "sample.riloom");
    const model = test.project(projectId).model;
    const legacy: ProjectModel = {
      projectId,
      formatVersion: "1.0.0",
      name: model.name,
      canvas: model.canvas,
      parameters: [],
    };
    test.close();
    const db = new DatabaseSync(path.join(directory, "project.sqlite"));
    db.prepare("UPDATE meta SET value=? WHERE key='model'").run(
      JSON.stringify(legacy),
    );
    db.prepare("UPDATE meta SET value=? WHERE key='stateHash'").run(
      JSON.stringify(hashValue(legacy)),
    );
    db.exec("DROP TABLE blobs; PRAGMA user_version=1");
    db.close();
    test.reopen();
    applyImported(test, projectId);
    const state = test.project(projectId);
    success(
      test.execute(
        request(
          "riloom.project.undo",
          { undoGroupId: state.undoGroupId },
          {
            projectId,
            expectedRevision: state.revision,
            expectedStateHash: state.stateHash,
            expectedHistoryVersion: state.historyVersion,
          },
        ),
      ),
    );
    expect(test.project(projectId).model).toEqual(legacy);
    expect(
      readFileSync(path.join(directory, "project.sqlite")).length,
    ).toBeGreaterThan(0);
  });
});
describe("shared scene semantics", () => {
  it("uses stable layer order, alpha-aware selection and linear compositing", () => {
    const { test, projectId } = setup();
    applyImported(test, projectId);
    const asset = test.project(projectId).model.assets![0]! as Asset;
    const red: DrawItem = {
      id: "red",
      name: "红色",
      assetId: "redAsset",
      x: 0,
      y: 0,
      visible: true,
      opacity: 1,
      drawOrder: 0,
      orderToken: "a",
    };
    const blue: DrawItem = {
      ...red,
      id: "blue",
      name: "蓝色",
      assetId: "blueAsset",
      drawOrder: 1,
      orderToken: "b",
    };
    const sources = new Map([
      [
        "redAsset",
        {
          asset: { ...asset, width: 1, height: 1 },
          data: new Uint8Array([255, 0, 0, 255]),
        },
      ],
      [
        "blueAsset",
        {
          asset: { ...asset, width: 1, height: 1 },
          data: new Uint8Array([0, 0, 255, 128]),
        },
      ],
    ]);
    const rgba = sampleComposite([blue, red], sources, 0, 0).map((v) =>
      Math.round(v * 255),
    );
    expect(rgba).toEqual([187, 0, 188, 255]);
    expect(hitTest([red, blue], sources, 0, 0)).toBe("blue");
    expect(hitTest([red, { ...blue, visible: false }], sources, 0, 0)).toBe(
      "red",
    );
    expect(
      orderedDrawItems([{ ...blue, drawOrder: 0 }, red]).map((item) => item.id),
    ).toEqual(["red", "blue"]);
  });
  it("keeps UV-free image geometry and restores drawing properties atomically", () => {
    const { test, projectId } = setup();
    applyImported(test, projectId);
    const model = test.project(projectId).model,
      before = model.drawItems![0]!;
    const after = {
      ...before,
      x: -12.5,
      y: 3,
      visible: false,
      opacity: 0.3,
      drawOrder: 5,
    };
    const result = applyChanges(model, [
      { type: "updateDrawItem", before, after },
    ]);
    expect(applyChanges(result.model, result.inverse).model).toEqual(model);
    expect(() =>
      applyChanges(model, [{ type: "removeAsset", before: model.assets![0]! }]),
    ).toThrow();
  });
});

it("keeps editing isolated while the original import result is unresolved", async () => {
  const { test, projectId } = setup();
  const values = new Map<string, string>();
  let loseResponse = true;
  const editor = new Editor(
    async (input) => {
      const receipt = test.execute(input);
      if (input.command === "riloom.asset.import" && loseResponse) {
        loseResponse = false;
        throw new RiloomError("EFFECT_UNRESOLVED", "response lost");
      }
      return receipt;
    },
    test.store.workspaceId,
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  );
  await editor.open(projectId);
  await editor.importPng("重试图层", png().toString("base64"));
  expect(editor.importPending).toBe(true);
  editor.addParameter();
  expect(editor.getSnapshot().parameters).toHaveLength(0);
  await editor.retryImport();
  expect(editor.importPending).toBe(false);
  expect(editor.getSnapshot().drawItems).toHaveLength(1);
  await editor.apply();
  expect(test.project(projectId).model.drawItems).toHaveLength(1);
  expect(editor.getSnapshot().error).toBeNull();
});
it("rejects asset dimensions that disagree with the registered source", () => {
  const { test, projectId } = setup();
  const asset = imported(test, projectId).receipt.result.asset as Asset;
  const receipt = test.save(projectId, [
    {
      type: "addAsset",
      after: { ...asset, id: "wrong-shape", width: 4, height: 1 },
    },
  ]);
  expect(receipt).toMatchObject({
    status: "failed",
    error: { code: "INVALID_INPUT" },
  });
});

it("rejects an import beyond the draft limit without changing saved resources", () => {
  const { test, projectId } = setup();
  applyImported(test, projectId);
  const model = test.project(projectId).model;
  const changes = Array.from(
    { length: 128 },
    (_, index) => index,
  ).flatMap<Change>((index) => {
    const asset = { ...model.assets![0]!, id: `asset-${index}` };
    const drawing = {
      ...model.drawItems![0]!,
      id: `drawing-${index}`,
      assetId: asset.id,
      orderToken: `order-${index}`,
    };
    return [
      { type: "addAsset", after: asset },
      { type: "addDrawItem", after: drawing },
    ];
  });
  const draft = success(test.save(projectId, changes)).result.draft as Draft;
  expect(draft.changes).toHaveLength(256);
  const registered = test.store.openProject(projectId).read((tx) => tx.blobs());
  const input = request(
    "riloom.asset.import",
    {
      name: "超额图层",
      pngBase64: PNG.sync
        .write(
          Object.assign(new PNG(), {
            width: 1,
            height: 1,
            data: Buffer.from([1, 2, 3, 255]),
            gamma: 0,
          }),
        )
        .toString("base64"),
      draftId: draft.draftId,
    },
    { projectId, expectedDraftVersion: draft.draftVersion },
  );
  const failed = test.execute(input);
  expect(failed).toMatchObject({
    status: "failed",
    error: { code: "INVALID_INPUT" },
  });
  expect(test.execute(input)).toEqual(failed);
  test.reopen();
  expect(
    success(
      test.execute(
        request(
          "riloom.project.getDraft",
          {
            draftId: draft.draftId,
          },
          { projectId },
        ),
      ),
    ).result.draft,
  ).toEqual(draft);
  expect(test.store.openProject(projectId).read((tx) => tx.blobs())).toEqual(
    registered,
  );
  const state = test.project(projectId);
  success(
    test.execute(
      request(
        "riloom.project.backup",
        {
          projectId,
          expectedRevision: state.revision,
          expectedStateHash: state.stateHash,
          expectedStorageGeneration: state.storageGeneration,
        },
        { workspaceId: test.store.workspaceId },
      ),
    ),
  );
});

it.each(["before refresh", "during refresh"])(
  "preserves an unresolved import started %s and continues editing after retry",
  async (timing) => {
    const { test, projectId } = setup();
    const values = new Map<string, string>();
    let loseResponse = true;
    let holdRefresh = false;
    let releaseRefresh: (() => void) | undefined;
    const editor = new Editor(
      async (input) => {
        const receipt = test.execute(input);
        if (input.command === "riloom.project.get" && holdRefresh) {
          holdRefresh = false;
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        }
        if (input.command === "riloom.asset.import" && loseResponse) {
          loseResponse = false;
          throw new RiloomError("EFFECT_UNRESOLVED", "response lost");
        }
        return receipt;
      },
      test.store.workspaceId,
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      },
    );
    await editor.open(projectId);
    const draftKey = "riloom.draft." + projectId;
    const originalDraft = values.get(draftKey);
    const originalProject = editor.getSnapshot().project;
    test.apply(projectId, [
      { type: "addParameter", after: parameter("external") },
    ]);
    let refresh: Promise<void> | undefined;
    if (timing === "during refresh") {
      holdRefresh = true;
      refresh = editor.refreshCurrent();
      expect(releaseRefresh).toBeDefined();
    }
    await editor.importPng("重试图层", png().toString("base64"));
    expect(editor.importPending).toBe(true);
    if (refresh) {
      releaseRefresh!();
      await refresh;
    } else await editor.refreshCurrent();
    expect(values.get(draftKey)).toBe(originalDraft);
    expect(editor.getSnapshot().project).toEqual(originalProject);
    await editor.retryImport();
    expect(editor.importPending).toBe(false);
    const drawing = editor.getSnapshot().drawItems[0]!;
    editor.updateDrawing(drawing.id, { opacity: 0.5 });
    await editor.save();
    expect(editor.getSnapshot().error).toBeNull();
    expect(editor.getSnapshot().savedGeneration).toBe(
      editor.getSnapshot().generation,
    );
    await editor.refreshCurrent();
    await editor.rebase();
    await editor.apply();
    expect(editor.getSnapshot().error).toBeNull();
    test.reopen();
    await editor.open(projectId);
    expect(editor.getSnapshot().drawItems).toMatchObject([{ opacity: 0.5 }]);
    expect(editor.getSnapshot().parameters).toMatchObject([{ id: "external" }]);
    expect(editor.getSnapshot().error).toBeNull();
  },
);

it.each(["import first", "switch first"])(
  "serializes project switching and import preparation when started %s",
  async (order) => {
    const { test, projectId } = setup();
    const other = test.create("另一个工程", "other.riloom").projectId;
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    let releaseImport!: () => void;
    let importStarted!: () => void;
    const saveBarrier = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const importBarrier = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const uploading = new Promise<void>((resolve) => {
      importStarted = resolve;
    });
    let imports = 0;
    const values = new Map<string, string>();
    const editor = new Editor(
      async (input) => {
        if (input.command === "riloom.project.saveDraft") {
          saveStarted();
          await saveBarrier;
        }
        const receipt = test.execute(input);
        if (input.command === "riloom.asset.import") {
          imports++;
          if (order === "import first") {
            importStarted();
            await importBarrier;
          }
        }
        return receipt;
      },
      test.store.workspaceId,
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      },
    );
    await editor.open(projectId);
    editor.addParameter();
    const first =
      order === "import first"
        ? editor.importPng("原工程图层", png().toString("base64"))
        : editor.open(other);
    await saving;
    const second =
      order === "import first"
        ? editor.open(other)
        : editor.importPng("原工程图层", png().toString("base64"));
    releaseSave();
    if (order === "import first") {
      await uploading;
      await second;
      releaseImport();
    }
    await Promise.all([first, second]);
    expect(editor.importPending).toBe(false);
    expect(editor.getSnapshot().error).toBeNull();
    if (order === "import first") {
      expect(imports).toBe(1);
      expect(editor.getSnapshot().project!.model.projectId).toBe(projectId);
      expect(editor.getSnapshot().drawItems).toMatchObject([
        { name: "原工程图层" },
      ]);
      await editor.apply();
      expect(test.project(projectId).model.drawItems).toHaveLength(1);
      await editor.open(other);
    } else expect(imports).toBe(0);
    expect(editor.getSnapshot().project!.model.projectId).toBe(other);
    expect(editor.getSnapshot().drawItems).toHaveLength(0);
    expect(editor.getSnapshot().parameters).toHaveLength(0);
    expect(test.project(other).model.drawItems).toHaveLength(0);
    editor.dispose();
  },
);

it("releases import preparation after the initial save fails", async () => {
  const { test, projectId } = setup();
  const values = new Map<string, string>();
  const editor = new Editor(
    async (input) => test.execute(input),
    test.store.workspaceId,
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  );
  await editor.open(projectId);
  editor.addParameter();
  const id = editor.getSnapshot().selected!;
  editor.updateParameter(id, { value: 2 });
  await editor.importPng("重新导入", png().toString("base64"));
  expect(editor.importPending).toBe(false);
  expect(editor.getSnapshot().loading).toBe(false);
  expect(editor.getSnapshot().error).toBeTruthy();
  editor.updateParameter(id, { value: 0 });
  await editor.importPng("重新导入", png().toString("base64"));
  expect(editor.getSnapshot().error).toBeNull();
  expect(editor.getSnapshot().drawItems).toMatchObject([{ name: "重新导入" }]);
  expect(editor.importPending).toBe(false);
  editor.dispose();
});

it.each(["import", "switch"])(
  "locks the editing context against %s while rebasing",
  async (operation) => {
    const { test, projectId } = setup();
    const other = test.create("另一工程", "rebase-other.riloom").projectId;
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let holdRebase = false;
    let imports = 0;
    const values = new Map<string, string>();
    const editor = new Editor(
      async (input) => {
        const receipt = test.execute(input);
        if (input.command === "riloom.project.open" && holdRebase) {
          holdRebase = false;
          started();
          await barrier;
        }
        if (input.command === "riloom.asset.import") imports++;
        return receipt;
      },
      test.store.workspaceId,
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      },
    );
    await editor.open(projectId);
    editor.addParameter();
    await editor.save();
    test.apply(projectId, [
      { type: "addParameter", after: parameter("external") },
    ]);
    holdRebase = true;
    const rebasing = editor.rebase();
    await waiting;
    if (operation === "import")
      await editor.importPng("重准备后的图层", png().toString("base64"));
    else await editor.open(other);
    const during = editor.getSnapshot().project!.model.projectId;
    release();
    await rebasing;
    expect(during).toBe(projectId);
    expect(imports).toBe(0);
    expect(editor.getSnapshot().project!.model.projectId).toBe(projectId);
    expect(editor.getSnapshot().parameters).toHaveLength(2);
    expect(editor.getSnapshot().loading).toBe(false);
    expect(editor.getSnapshot().error).toBeNull();
    await editor.importPng("重准备后的图层", png().toString("base64"));
    await editor.apply();
    expect(test.project(projectId).model.drawItems).toHaveLength(1);
    expect(test.project(projectId).model.parameters).toHaveLength(2);
    expect(test.project(other).model.drawItems).toHaveLength(0);
    editor.dispose();
  },
);

it("releases the rebase context after a failed project read", async () => {
  const { test, projectId } = setup();
  let failRead = false;
  const values = new Map<string, string>();
  const editor = new Editor(
    async (input) => {
      if (input.command === "riloom.project.open" && failRead) {
        failRead = false;
        throw new RiloomError("EFFECT_UNRESOLVED", "read interrupted");
      }
      return test.execute(input);
    },
    test.store.workspaceId,
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  );
  await editor.open(projectId);
  editor.addParameter();
  await editor.save();
  failRead = true;
  await editor.rebase();
  expect(editor.getSnapshot().loading).toBe(false);
  expect(editor.getSnapshot().error).toBeTruthy();
  await editor.importPng("读取失败后导入", png().toString("base64"));
  await editor.apply();
  expect(editor.getSnapshot().error).toBeNull();
  expect(test.project(projectId).model.drawItems).toHaveLength(1);
  expect(test.project(projectId).model.parameters).toHaveLength(1);
  editor.dispose();
});
