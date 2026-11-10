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
  DrawItem,
  ProjectModel,
} from "../packages/contracts/dist/index.js";
import { fixture, request, success } from "./helpers.js";

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
