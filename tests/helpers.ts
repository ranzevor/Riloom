import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Application } from "../packages/application/dist/index.js";
import {
  SQLiteWorkspace,
  type StorageOptions,
} from "../packages/storage/dist/index.js";
import type {
  Candidate,
  Change,
  CommandRequest,
  Draft,
  Parameter,
  ProjectState,
  Receipt,
} from "../packages/contracts/dist/index.js";

export function parameter(id = "angle", name = "角度"): Parameter {
  return { id, name, unit: "度", min: -30, default: 0, max: 30, value: 0 };
}
export function request(
  command: string,
  arguments_: Record<string, unknown> = {},
  fields: Partial<CommandRequest> = {},
): CommandRequest {
  return {
    requestId: randomUUID(),
    command,
    commandVersion: "1.0.0",
    arguments: arguments_,
    ...fields,
  };
}
export function success(receipt: Receipt): Receipt {
  if (receipt.status !== "succeeded")
    throw new Error(JSON.stringify(receipt.error));
  return receipt;
}
export function temporaryDirectory(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "riloom-test-")));
}
export function removeDirectory(directory: string): void {
  if (
    path.dirname(directory) !== realpathSync(os.tmpdir()) ||
    !path.basename(directory).startsWith("riloom-test-")
  ) {
    throw new Error("Unexpected test directory");
  }
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
export function fixture(sharedLockDirectory?: string) {
  const root = temporaryDirectory(),
    directory = path.join(root, "workspace"),
    lockDirectory = sharedLockDirectory ?? path.join(root, "locks");
  let store: SQLiteWorkspace | undefined;
  let application: Application;
  function open(options: StorageOptions = {}) {
    store = new SQLiteWorkspace(directory, { lockDirectory, ...options });
    application = new Application(store, randomUUID(), "test-cursor-key");
  }
  open();
  const execute = (input: CommandRequest) => application.execute(input);
  const create = (name = "测试工程", folder = "sample.riloom") => {
    const command = request(
      "riloom.project.create",
      { name, directory: folder, canvas: { width: 1024, height: 1024 } },
      { workspaceId: store!.workspaceId },
    );
    const receipt = success(execute(command));
    return { projectId: receipt.result.projectId as string, receipt, command };
  };
  const project = (id: string) =>
    success(execute(request("riloom.project.get", {}, { projectId: id })))
      .result.project as ProjectState;
  const save = (
    projectId: string,
    changes: Change[],
    fields: Partial<CommandRequest> = {},
    args: Record<string, unknown> = {},
  ) => {
    const state = project(projectId);
    return execute(
      request(
        "riloom.project.saveDraft",
        {
          draftId: randomUUID(),
          editorId: "test-editor",
          baseRevision: state.revision,
          baseStateHash: state.stateHash,
          editGeneration: 1,
          changes,
          ...args,
        },
        { projectId, expectedDraftVersion: 0, ...fields },
      ),
    );
  };
  const prepare = (projectId: string, draft: Draft) =>
    success(
      execute(
        request(
          "riloom.project.prepareDraft",
          { draftId: draft.draftId },
          { projectId, expectedDraftVersion: draft.draftVersion },
        ),
      ),
    ).result.candidate as Candidate;
  const applyRequest = (
    projectId: string,
    draft: Draft,
    candidate: Candidate,
  ) => {
    const state = project(projectId);
    return request(
      "riloom.project.apply",
      { draftId: draft.draftId, candidateId: candidate.candidateId },
      {
        projectId,
        expectedRevision: state.revision,
        expectedStateHash: state.stateHash,
        expectedDraftVersion: draft.draftVersion,
      },
    );
  };
  const apply = (projectId: string, changes: Change[]) => {
    const draft = success(save(projectId, changes)).result.draft as Draft;
    return success(
      execute(applyRequest(projectId, draft, prepare(projectId, draft))),
    );
  };
  const close = () => {
    store?.close();
    store = undefined;
  };
  return {
    root,
    directory,
    lockDirectory,
    execute,
    create,
    project,
    save,
    prepare,
    applyRequest,
    apply,
    close,
    get store() {
      return store!;
    },
    reopen(options: StorageOptions = {}) {
      close();
      open(options);
    },
    dispose() {
      close();
      removeDirectory(root);
    },
  };
}
