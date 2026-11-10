import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  BackupInfo,
  Draft,
  ProjectState,
  CommandRequest,
} from "../packages/contracts/dist/index.js";
import { fixture, parameter, request, success } from "./helpers.js";

let f: ReturnType<typeof fixture> | undefined;
let second: ReturnType<typeof fixture> | undefined;
afterEach(() => {
  second?.dispose();
  second = undefined;
  f?.dispose();
  f = undefined;
});
const setup = () => (f = fixture());
function backup(projectId: string) {
  const state = f!.project(projectId);
  const input = request(
    "riloom.project.backup",
    {
      projectId,
      expectedRevision: state.revision,
      expectedStateHash: state.stateHash,
      expectedStorageGeneration: state.storageGeneration,
    },
    { workspaceId: f!.store.workspaceId },
  );
  const receipt = success(f!.execute(input));
  return { input, receipt, backup: receipt.result.backup as BackupInfo };
}
function restoreInput(info: BackupInfo, directory = "restored.riloom") {
  const state = f!.project(info.projectId);
  return request(
    "riloom.project.restore",
    {
      backupId: info.backupId,
      directory,
      expectedProject: {
        storageGeneration: state.storageGeneration,
        revision: state.revision,
        stateHash: state.stateHash,
      },
    },
    { workspaceId: f!.store.workspaceId },
  );
}
describe("project backup and recovery", () => {
  it("preserves saved drafts, model history and original receipts across restore and restart", () => {
    const test = setup(),
      { projectId } = test.create();
    const applied = test.apply(projectId, [
      { type: "addParameter", after: parameter() },
    ]);
    const draft = success(
      test.save(projectId, [
        { type: "addParameter", after: parameter("second") },
      ]),
    ).result.draft as Draft;
    const saved = backup(projectId),
      original = test.project(projectId);
    test.apply(projectId, [
      {
        type: "updateParameter",
        before: parameter(),
        after: { ...parameter(), value: 12 },
      },
    ]);
    const restored = success(test.execute(restoreInput(saved.backup))).result
      .project as ProjectState;
    expect(restored.model).toEqual(original.model);
    expect(restored.storageGeneration).not.toBe(original.storageGeneration);
    expect(
      existsSync(path.join(test.directory, "sample.riloom", "project.sqlite")),
    ).toBe(true);
    expect(
      test.execute(
        request(
          "riloom.project.getDraft",
          { draftId: draft.draftId },
          { projectId },
        ),
      ).result.draft,
    ).toEqual(draft);
    expect(
      test.execute(
        request(
          "riloom.project.getOperation",
          { requestId: applied.requestId },
          { projectId },
        ),
      ).result.operation,
    ).toEqual(applied);
    test.reopen();
    expect(test.project(projectId)).toEqual(restored);
    expect(test.execute(saved.input)).toEqual(saved.receipt);
    expect(
      test.save(projectId, [{ type: "addParameter", after: parameter("new") }]),
    ).toMatchObject({ status: "failed", error: { code: "EFFECT_UNRESOLVED" } });
    const accepted = success(
      test.save(
        projectId,
        [{ type: "addParameter", after: parameter("new") }],
        { expectedStorageGeneration: restored.storageGeneration },
      ),
    ).result.draft as Draft;
    const prepared = test.execute(
      request(
        "riloom.project.prepareDraft",
        { draftId: accepted.draftId },
        {
          projectId,
          expectedDraftVersion: accepted.draftVersion,
          expectedStorageGeneration: restored.storageGeneration,
        },
      ),
    );
    expect(prepared.status).toBe("succeeded");
  });
  it("restores shared undo history and rejects a write with the old storage generation", () => {
    const test = setup(),
      { projectId } = test.create();
    test.apply(projectId, [{ type: "addParameter", after: parameter() }]);
    const old = test.project(projectId),
      saved = backup(projectId);
    const restored = success(test.execute(restoreInput(saved.backup))).result
      .project as ProjectState;
    const input = request(
      "riloom.project.undo",
      { undoGroupId: restored.undoGroupId },
      {
        projectId,
        expectedRevision: restored.revision,
        expectedStateHash: restored.stateHash,
        expectedHistoryVersion: restored.historyVersion,
        expectedStorageGeneration: old.storageGeneration,
      },
    );
    expect(test.execute(input)).toMatchObject({
      status: "failed",
      error: { code: "PERMISSION_DENIED" },
    });
    input.requestId += "-current";
    input.expectedStorageGeneration = restored.storageGeneration;
    expect(success(test.execute(input)).result.project).toMatchObject({
      revision: 2,
      model: { parameters: [] },
    });
  });
  it("rejects stale restore conditions and protects an occupied destination", () => {
    const test = setup(),
      { projectId } = test.create(),
      saved = backup(projectId),
      stale = restoreInput(saved.backup);
    test.apply(projectId, [{ type: "addParameter", after: parameter() }]);
    expect(test.execute(stale)).toMatchObject({
      status: "failed",
      error: { code: "REVISION_CONFLICT" },
    });
    const directory = path.join(test.directory, "occupied.riloom");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "keep.txt"), "keep");
    expect(
      test.execute(restoreInput(saved.backup, "occupied.riloom")),
    ).toMatchObject({ status: "failed", error: { code: "RESOURCE_BUSY" } });
    expect(readFileSync(path.join(directory, "keep.txt"), "utf8")).toBe("keep");
  });
  it("imports a portable backup and refuses an identity already owned by another workspace", () => {
    const test = setup(),
      { projectId } = test.create(),
      saved = backup(projectId);
    second = fixture(test.lockDirectory);
    const imported = success(
      second.execute(
        request(
          "riloom.project.importBackup",
          { directory: saved.backup.directory },
          { workspaceId: second.store.workspaceId },
        ),
      ),
    ).result.backup as BackupInfo;
    const input = request(
      "riloom.project.restore",
      { backupId: imported.backupId, directory: "portable.riloom" },
      { workspaceId: second.store.workspaceId },
    );
    expect(second.execute(input)).toMatchObject({
      status: "failed",
      error: { code: "RESOURCE_BUSY" },
    });
    test.close();
    input.requestId += "-released";
    expect(success(second.execute(input)).result.project).toMatchObject({
      model: { projectId },
      revision: 0,
    });
  });
  it("detects corruption without modifying the backup", () => {
    const test = setup(),
      { projectId } = test.create(),
      saved = backup(projectId);
    const filename = path.join(saved.backup.directory, "project.sqlite"),
      data = readFileSync(filename);
    data[data.length - 1] = data[data.length - 1]! ^ 1;
    writeFileSync(filename, data);
    expect(test.execute(restoreInput(saved.backup))).toMatchObject({
      status: "failed",
      error: { code: "DATA_CORRUPT" },
    });
    expect(readFileSync(filename)).toEqual(data);
    expect(test.project(projectId).revision).toBe(0);
  });
  it("recovers a damaged current database using the registered identity", () => {
    const test = setup(),
      { projectId } = test.create(),
      saved = backup(projectId),
      generation = test.project(projectId).storageGeneration;
    test.reopen();
    const db = new DatabaseSync(
      path.join(test.directory, "sample.riloom", "project.sqlite"),
    );
    db.prepare("UPDATE meta SET value=? WHERE key='stateHash'").run("null");
    db.close();
    const input = request(
      "riloom.project.restore",
      {
        backupId: saved.backup.backupId,
        directory: "repaired.riloom",
        expectedProject: { storageGeneration: generation },
      },
      { workspaceId: test.store.workspaceId },
    );
    expect(success(test.execute(input)).result.project).toMatchObject({
      revision: 0,
      model: { projectId },
    });
  });
  it("upgrades a version-one workspace without changing its project", () => {
    const test = setup(),
      created = test.create(),
      state = test.project(created.projectId);
    test.close();
    const db = new DatabaseSync(path.join(test.directory, "workspace.sqlite"));
    db.exec(
      "DROP TABLE backups; DROP TABLE backup_intents; ALTER TABLE projects DROP COLUMN record_version; DELETE FROM meta WHERE key IN ('projectsVersion','backupsVersion'); PRAGMA user_version=1;",
    );
    db.close();
    test.reopen();
    expect(test.project(created.projectId)).toEqual(state);
    expect(test.execute(created.command)).toEqual(created.receipt);
    expect(backup(created.projectId).backup.revision).toBe(0);
  });
  it.each([
    "backup-intent",
    "backup-copied",
    "backup-published",
    "restore-intent",
    "restore-copied",
    "restore-published",
    "restore-registered",
  ])("recovers process termination at %s", (point) => {
    const test = setup(),
      { projectId } = test.create();
    let input: CommandRequest;
    if (point.startsWith("restore"))
      input = restoreInput(backup(projectId).backup);
    else {
      const state = test.project(projectId);
      input = request(
        "riloom.project.backup",
        {
          projectId,
          expectedRevision: 0,
          expectedStateHash: state.stateHash,
          expectedStorageGeneration: state.storageGeneration,
        },
        { workspaceId: test.store.workspaceId },
      );
    }
    test.close();
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/crash-worker.mjs", import.meta.url)),
        test.directory,
        test.lockDirectory,
        point,
        JSON.stringify(input),
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    expect(child.stdout + child.stderr).toContain("checkpoint:" + point);
    test.reopen();
    const completed = success(test.execute(input));
    expect(completed).toEqual(test.store.receipt(input.requestId));
    expect(test.project(projectId).revision).toBe(0);
  });

  it("rejects a different valid backup that reuses an existing backup identity", () => {
    const test = setup(),
      { projectId } = test.create(),
      first = backup(projectId);
    test.apply(projectId, [{ type: "addParameter", after: parameter() }]);
    const next = backup(projectId),
      clone = path.join(test.root, "conflict.riloombackup");
    mkdirSync(clone);
    copyFileSync(
      path.join(next.backup.directory, "project.sqlite"),
      path.join(clone, "project.sqlite"),
    );
    const manifest = JSON.parse(
      readFileSync(path.join(next.backup.directory, "backup.json"), "utf8"),
    );
    manifest.backupId = first.backup.backupId;
    writeFileSync(path.join(clone, "backup.json"), JSON.stringify(manifest));
    expect(
      test.execute(
        request(
          "riloom.project.importBackup",
          { directory: clone },
          { workspaceId: test.store.workspaceId },
        ),
      ),
    ).toMatchObject({ status: "failed", error: { code: "DATA_CORRUPT" } });
    expect(
      test.execute(
        request(
          "riloom.project.listBackups",
          {},
          { workspaceId: test.store.workspaceId },
        ),
      ).result.items,
    ).toHaveLength(2);
  });

  it("rejects invalid stored generations even when the backup file checksum is valid", () => {
    const test = setup(),
      { projectId } = test.create(),
      saved = backup(projectId);
    const directory = path.join(test.root, "malformed.riloombackup");
    mkdirSync(directory);
    const filename = path.join(directory, "project.sqlite");
    copyFileSync(path.join(saved.backup.directory, "project.sqlite"), filename);
    const db = new DatabaseSync(filename);
    db.exec("UPDATE meta SET value='null' WHERE key='storageGeneration'");
    db.close();
    const manifest = JSON.parse(
      readFileSync(path.join(saved.backup.directory, "backup.json"), "utf8"),
    );
    const data = readFileSync(filename);
    manifest.database = {
      bytes: data.length,
      hash: {
        algorithm: "sha256",
        digest: createHash("sha256").update(data).digest("hex"),
      },
    };
    writeFileSync(
      path.join(directory, "backup.json"),
      JSON.stringify(manifest),
    );
    expect(
      test.execute(
        request(
          "riloom.project.importBackup",
          { directory },
          { workspaceId: test.store.workspaceId },
        ),
      ),
    ).toMatchObject({ status: "failed", error: { code: "DATA_CORRUPT" } });
  });
});
