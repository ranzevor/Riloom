import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  commands,
  RiloomError,
  validateRequest,
  version,
  type Candidate,
  type Change,
  type CommandRequest,
  type Draft,
  type Receipt,
  type StateHash,
  type Asset,
  type DrawItem,
  type BlobRef,
} from "@riloom/contracts";
import {
  applyChanges,
  asJson,
  canonicalJson,
  validateModel,
  changeBlobs,
} from "@riloom/core";
import type { ProjectTransaction, WorkspacePersistence } from "./ports.js";
import { decodePng } from "@riloom/image";
export * from "./ports.js";

export function hashValue(value: unknown): StateHash {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(canonicalJson(value)).digest("hex"),
  };
}
export function sameHash(a: StateHash, b: StateHash): boolean {
  return (
    a?.algorithm === "sha256" &&
    b?.algorithm === "sha256" &&
    a.digest === b.digest
  );
}
function rejectReuse(receipt: Receipt, inputHash: StateHash): Receipt {
  if (!sameHash(receipt.inputHash, inputHash))
    throw new RiloomError("REQUEST_ID_REUSED", "请求标识已用于另一组输入");
  return receipt;
}
function requireDraft(
  tx: ProjectTransaction,
  id: string,
  expected: number | undefined,
): Draft {
  const draft = tx.draft(id);
  if (!draft) throw new RiloomError("NOT_FOUND", "草稿不存在");
  if (draft.draftStatus !== "editing" || draft.draftVersion !== expected)
    throw new RiloomError("REVISION_CONFLICT", "草稿版本已变化", {
      draftId: id,
      draftVersion: draft.draftVersion,
      draftStatus: draft.draftStatus,
    });
  return draft;
}
export class Application {
  constructor(
    readonly workspace: WorkspacePersistence,
    private readonly generation: string,
    private readonly cursorSecret: string,
  ) {}
  execute(value: unknown): Receipt {
    const request = validateRequest(value);
    const spec = commands[request.command as keyof typeof commands];
    if (
      request.workspaceId !== undefined &&
      request.workspaceId !== this.workspace.workspaceId
    )
      throw new RiloomError("PERMISSION_DENIED", "请求不属于当前工作区");
    const inputHash = hashValue(request);
    if (spec.scope === "workspace") {
      if (spec.kind !== "query") {
        const previous = this.workspace.receipt(request.requestId);
        if (previous) return rejectReuse(previous, inputHash);
      }
      this.requireVersion(request);
      if (request.command === "riloom.project.create") {
        const args = request.arguments as {
          name: string;
          directory: string;
          canvas: { width: number; height: number };
        };
        const model = {
          projectId: randomUUID(),
          formatVersion: "1.1.0" as const,
          name: args.name,
          canvas: args.canvas,
          parameters: [],
          assets: [],
          drawItems: [],
        };
        validateModel(model);
        return this.workspace.createProject({
          request,
          inputHash,
          operationId: randomUUID(),
          model,
          directory: args.directory,
        });
      }
      if (spec.kind === "maintenance") {
        return this.workspace.manageBackup({
          request,
          inputHash,
          operationId: randomUUID(),
        });
      }
      if (request.command === "riloom.project.prepareRestore") {
        return this.receipt(
          request,
          inputHash,
          {
            plan: this.workspace.prepareRestore(
              request.arguments.backupId as string,
            ),
          },
          0,
        );
      }
      if (request.command === "riloom.project.open") {
        const project = this.workspace
          .openProject(request.arguments.projectId as string)
          .read((tx) => tx.state());
        return this.receipt(
          request,
          inputHash,
          { project },
          project.eventCursor,
        );
      }
      if (request.command === "riloom.project.listBackups") {
        const collection = this.workspace.listBackups(
          request.arguments.projectId as string | undefined,
        );
        return this.receipt(
          request,
          inputHash,
          this.page(
            collection.items,
            collection.version,
            request,
            "backups:" + (request.arguments.projectId ?? ""),
            (item) => item.backupId,
          ),
          0,
        );
      }
      const result =
        request.command === "riloom.workspace.get"
          ? {
              workspaceId: this.workspace.workspaceId,
              commands: Object.keys(commands),
              serviceGeneration: this.generation,
            }
          : request.command === "riloom.workspace.getOperation"
            ? {
                operation: this.requireReceipt(
                  this.workspace.receipt(request.arguments.requestId as string),
                ),
              }
            : this.listProjects(request);
      return this.receipt(request, inputHash, result, 0);
    }
    const store = this.workspace.openProject(request.projectId!);
    if (spec.kind === "query") {
      this.requireVersion(request);
      return store.read((tx) => {
        let result: Record<string, unknown>;
        switch (request.command) {
          case "riloom.asset.read": {
            const data = tx.readBlob(request.arguments.blob as BlobRef);
            const offset =
              (request.arguments.offset as number | undefined) ?? 0;
            const length =
              (request.arguments.length as number | undefined) ?? 4194304;
            if (offset > data.byteLength)
              throw new RiloomError("INVALID_INPUT", "素材读取位置超出范围");
            const chunk = data.subarray(offset, offset + length);
            result = {
              data: Buffer.from(chunk).toString("base64"),
              offset,
              bytes: data.byteLength,
              nextOffset: offset + chunk.length,
            };
            break;
          }
          case "riloom.project.get":
            result = { project: tx.state() };
            break;
          case "riloom.project.getOperation":
            result = {
              operation: this.requireReceipt(
                tx.receipt(request.arguments.requestId as string),
              ),
            };
            break;
          case "riloom.project.getDraft": {
            const draft = tx.draft(request.arguments.draftId as string);
            if (!draft) throw new RiloomError("NOT_FOUND", "草稿不存在");
            result = { draft, base: tx.modelAt(draft.baseRevision) };
            break;
          }
          case "riloom.project.listDrafts":
            result = this.page(
              tx.drafts().map((draft) => ({
                ...draft,
                recordVersion: draft.draftVersion,
              })),
              tx.draftsVersion(),
              request,
              "drafts",
              (draft) => draft.draftId,
            );
            break;
          default:
            throw new RiloomError("UNSUPPORTED_FEATURE", "该查询当前不可用");
        }
        return this.receipt(request, inputHash, result, tx.state().eventCursor);
      });
    }
    return store.write((tx) => {
      const previous = tx.receipt(request.requestId);
      if (previous) return rejectReuse(previous, inputHash);
      this.requireVersion(request);
      const operationId = randomUUID(),
        before = tx.state();
      let receipt: Receipt;
      try {
        receipt = tx.atomic(() => {
          if (
            request.expectedStorageGeneration !== undefined &&
            request.expectedStorageGeneration !== before.storageGeneration
          ) {
            throw new RiloomError(
              "PERMISSION_DENIED",
              "工程存储已变化，请重新打开工程",
            );
          }
          if (
            tx.requiresStorageGeneration() &&
            request.expectedStorageGeneration === undefined
          ) {
            throw new RiloomError(
              "EFFECT_UNRESOLVED",
              "请读取恢复后的工程，并以当前存储世代重新准备编辑",
            );
          }
          const result = this.edit(tx, request, operationId);
          const after = tx.state();
          const output = this.receipt(
            request,
            inputHash,
            result,
            after.eventCursor,
            operationId,
          );
          if (spec.kind === "apply") {
            output.beforeRevision = before.revision;
            output.afterRevision = after.revision;
            output.stateHash = after.stateHash;
          }
          return output;
        });
      } catch (error) {
        if (!(error instanceof RiloomError)) throw error;
        receipt = this.receipt(
          request,
          inputHash,
          {},
          tx.state().eventCursor,
          operationId,
        );
        receipt.status = "failed";
        receipt.error = {
          code: error.code,
          message: error.message,
          details: error.details,
        };
      }
      tx.saveReceipt(receipt);
      return receipt;
    });
  }
  private edit(
    tx: ProjectTransaction,
    request: CommandRequest,
    operationId: string,
  ): Record<string, unknown> {
    const args = request.arguments;
    if (request.command === "riloom.asset.import") {
      const state = tx.state();
      const draftId = (args.draftId as string | undefined) ?? randomUUID();
      const previous = tx.draft(draftId);
      if (previous) requireDraft(tx, draftId, request.expectedDraftVersion);
      else if (request.expectedDraftVersion !== 0)
        throw new RiloomError("REVISION_CONFLICT", "新草稿必须从版本零创建");
      const baseRevision =
        (args.baseRevision as number | undefined) ??
        previous?.baseRevision ??
        state.revision;
      const baseStateHash =
        (args.baseStateHash as StateHash | undefined) ??
        previous?.baseStateHash ??
        state.stateHash;
      const base = tx.modelAt(baseRevision);
      if (!sameHash(hashValue(base), baseStateHash))
        throw new RiloomError("REVISION_CONFLICT", "导入来源与工程记录不符");
      const encoded = args.pngBase64 as string,
        source = Buffer.from(encoded, "base64");
      if (source.toString("base64") !== encoded)
        throw new RiloomError("INVALID_INPUT", "PNG 编码无效");
      const image = decodePng(source);
      const sourceRef = tx.putBlob(source),
        pixelsRef = tx.putBlob(image.pixels);
      const asset: Asset = {
        id: randomUUID(),
        name: args.name as string,
        width: image.width,
        height: image.height,
        bitDepth: image.bitDepth,
        source: sourceRef,
        pixels: pixelsRef,
        colorSpace: "srgb",
        colorSource: image.colorSource,
      };
      const current = previous?.changes.length
        ? applyChanges(base, previous.changes).model
        : base;
      const drawOrder =
        Math.max(
          -1,
          ...(current.drawItems ?? []).map((item) => item.drawOrder),
        ) + 1;
      const drawing: DrawItem = {
        id: randomUUID(),
        name: asset.name,
        assetId: asset.id,
        x: (base.canvas.width - asset.width) / 2,
        y: (base.canvas.height - asset.height) / 2,
        visible: true,
        opacity: 1,
        drawOrder,
        orderToken: randomUUID(),
      };
      const changes: Change[] = [...(previous?.changes ?? [])];
      if (current.formatVersion === "1.0.0")
        changes.push({ type: "setFormat", before: "1.0.0", after: "1.1.0" });
      changes.push(
        { type: "addAsset", after: asset },
        { type: "addDrawItem", after: drawing },
      );
      const saved = this.edit(
        tx,
        validateRequest({
          ...request,
          command: "riloom.project.saveDraft",
          arguments: {
            draftId,
            editorId:
              (args.editorId as string | undefined) ??
              previous?.editorId ??
              "asset-import",
            baseRevision,
            baseStateHash,
            editGeneration: (previous?.editGeneration ?? 0) + 1,
            changes,
          },
        }),
        operationId,
      );
      const draft = saved.draft as Draft;
      const prepared = this.edit(
        tx,
        {
          ...request,
          command: "riloom.project.prepareDraft",
          expectedDraftVersion: draft.draftVersion,
          arguments: { draftId },
        },
        operationId,
      );
      return { ...prepared, asset, drawing, draft, analysis: image.analysis };
    }
    if (request.command === "riloom.project.saveDraft") {
      const fields = args as unknown as {
        draftId: string;
        editorId: string;
        baseRevision: number;
        baseStateHash: StateHash;
        editGeneration: number;
        changes: Change[];
      };
      const old = tx.draft(fields.draftId);
      if (old) {
        requireDraft(tx, fields.draftId, request.expectedDraftVersion);
        if (
          old.editorId !== fields.editorId ||
          old.baseRevision !== fields.baseRevision ||
          !sameHash(old.baseStateHash, fields.baseStateHash)
        )
          throw new RiloomError(
            "INVALID_INPUT",
            "草稿身份和基线在创建后保持固定",
          );
        if (fields.editGeneration <= old.editGeneration)
          throw new RiloomError("REVISION_CONFLICT", "编辑代次必须递增");
      } else if (request.expectedDraftVersion !== 0)
        throw new RiloomError("REVISION_CONFLICT", "新草稿必须从版本零创建");
      const base = tx.modelAt(fields.baseRevision);
      if (!sameHash(hashValue(base), fields.baseStateHash))
        throw new RiloomError("REVISION_CONFLICT", "草稿基线与工程记录不符");
      tx.requireBlobs(changeBlobs(fields.changes));
      for (const change of fields.changes) {
        if (change.type !== "addAsset") continue;
        const asset = change.after;
        const image = decodePng(tx.readBlob(asset.source));
        const digest = createHash("sha256").update(image.pixels).digest("hex");
        if (
          image.width !== asset.width ||
          image.height !== asset.height ||
          image.bitDepth !== asset.bitDepth ||
          image.colorSource !== asset.colorSource ||
          digest !== asset.pixels.hash.digest
        )
          throw new RiloomError("INVALID_INPUT", "素材描述与原始图像不一致");
      }
      const calculated = fields.changes.length
        ? applyChanges(base, fields.changes)
        : { model: base, inverse: [] };
      const draft: Draft = {
        projectId: request.projectId!,
        ...fields,
        draftVersion: (old?.draftVersion ?? 0) + 1,
        draftStatus: "editing",
        inverseChanges: calculated.inverse,
      };
      tx.saveDraft(draft);
      tx.addEvent("draft.saved", operationId, {
        draftId: draft.draftId,
        draftVersion: draft.draftVersion,
      });
      return { draft };
    }
    if (request.command === "riloom.project.discardDraft") {
      const draft = requireDraft(
        tx,
        args.draftId as string,
        request.expectedDraftVersion,
      );
      draft.draftStatus = "discarded";
      draft.draftVersion++;
      tx.saveDraft(draft);
      tx.addEvent("draft.discarded", operationId, { draftId: draft.draftId });
      return { draft };
    }
    if (request.command === "riloom.project.prepareDraft") {
      const draft = requireDraft(
        tx,
        args.draftId as string,
        request.expectedDraftVersion,
      );
      const base = tx.modelAt(draft.baseRevision);
      if (!sameHash(hashValue(base), draft.baseStateHash))
        throw new RiloomError("DATA_CORRUPT", "草稿基线记录损坏");
      applyChanges(base, draft.changes);
      const candidate: Candidate = {
        candidateId: randomUUID(),
        draftId: draft.draftId,
        draftVersion: draft.draftVersion,
        sourceRevision: draft.baseRevision,
        sourceStateHash: draft.baseStateHash,
        changes: draft.changes,
        inverseChanges: draft.inverseChanges,
        status: "ready",
      };
      tx.saveCandidate(candidate);
      tx.addEvent("candidate.prepared", operationId, {
        candidateId: candidate.candidateId,
      });
      return { candidate };
    }
    const state = tx.state();
    if (
      state.revision !== request.expectedRevision ||
      !request.expectedStateHash ||
      !sameHash(state.stateHash, request.expectedStateHash)
    )
      throw new RiloomError("REVISION_CONFLICT", "工程已变化，请读取当前工程", {
        revision: state.revision,
        stateHash: asJson(state.stateHash),
      });
    if (request.command === "riloom.project.apply") {
      const draft = requireDraft(
        tx,
        args.draftId as string,
        request.expectedDraftVersion,
      );
      const candidate = tx.candidate(args.candidateId as string);
      if (
        !candidate ||
        candidate.status !== "ready" ||
        candidate.draftId !== draft.draftId ||
        candidate.draftVersion !== draft.draftVersion ||
        candidate.sourceRevision !== state.revision ||
        !sameHash(candidate.sourceStateHash, state.stateHash)
      )
        throw new RiloomError(
          "REVISION_CONFLICT",
          "候选与当前工程或草稿版本不符",
        );
      const calculated = applyChanges(state.model, candidate.changes);
      const project = tx.apply(
        calculated.model,
        candidate.changes,
        calculated.inverse,
        operationId,
      );
      draft.draftVersion++;
      draft.draftStatus = "applied";
      tx.saveDraft(draft);
      candidate.status = "applied";
      tx.saveCandidate(candidate);
      return {
        project,
        draft,
        undoGroupId: project.undoGroupId,
        historyVersion: project.historyVersion,
      };
    }
    if (
      request.command === "riloom.project.undo" ||
      request.command === "riloom.project.redo"
    ) {
      const direction =
        request.command === "riloom.project.undo" ? "undo" : "redo";
      const group = tx.historyGroup(direction);
      if (
        state.historyVersion !== request.expectedHistoryVersion ||
        !group ||
        group.id !== args.undoGroupId
      )
        throw new RiloomError("REVISION_CONFLICT", "历史位置已变化");
      const changes = direction === "undo" ? group.inverse : group.changes;
      const calculated = applyChanges(state.model, changes);
      return {
        project: tx.apply(
          calculated.model,
          changes,
          calculated.inverse,
          operationId,
          { direction, group },
        ),
      };
    }
    throw new RiloomError("UNSUPPORTED_FEATURE", "该编辑当前不可用");
  }
  private requireReceipt(receipt: Receipt | null): Receipt {
    if (!receipt) throw new RiloomError("NOT_FOUND", "请求回执不存在");
    return receipt;
  }
  private requireVersion(request: CommandRequest): void {
    if (request.commandVersion !== version)
      throw new RiloomError("UNSUPPORTED_VERSION", "命令版本不受支持");
  }
  private receipt(
    request: CommandRequest,
    inputHash: StateHash,
    result: Record<string, unknown>,
    eventCursor: number,
    operationId = randomUUID(),
  ): Receipt {
    return {
      operationId,
      requestId: request.requestId,
      command: request.command,
      commandVersion: request.commandVersion,
      scope: request.projectId
        ? {
            workspaceId: this.workspace.workspaceId,
            projectId: request.projectId,
          }
        : { workspaceId: this.workspace.workspaceId },
      status: "succeeded",
      inputHash,
      result,
      artifactRefs: [],
      eventCursor,
    };
  }
  private listProjects(request: CommandRequest): Record<string, unknown> {
    const collection = this.workspace.listProjects();
    return this.page(
      collection.items,
      collection.version,
      request,
      "projects",
      (item) => item.projectId,
    );
  }
  private page<T>(
    items: T[],
    collectionVersion: number,
    request: CommandRequest,
    collection: string,
    idOf: (item: T) => string,
  ): Record<string, unknown> {
    const limit = (request.arguments.limit as number | undefined) ?? 50;
    const scope = request.projectId ?? this.workspace.workspaceId;
    let after = "";
    if (request.arguments.cursor) {
      const [encoded, signature] = (request.arguments.cursor as string).split(
        ".",
      );
      if (!encoded || !signature)
        throw new RiloomError("INVALID_INPUT", "分页游标格式错误");
      const wanted = createHmac("sha256", this.cursorSecret)
        .update(encoded)
        .digest("base64url");
      const actualBytes = Buffer.from(signature),
        expectedBytes = Buffer.from(wanted);
      if (
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      )
        throw new RiloomError("INVALID_INPUT", "分页游标校验失败");
      let cursor: {
        generation: string;
        scope: string;
        collection: string;
        version: number;
        limit: number;
        after: string;
      };
      try {
        cursor = JSON.parse(Buffer.from(encoded, "base64url").toString());
      } catch {
        throw new RiloomError("INVALID_INPUT", "分页游标格式错误");
      }
      if (
        cursor.generation !== this.generation ||
        cursor.scope !== scope ||
        cursor.collection !== collection ||
        cursor.version !== collectionVersion ||
        cursor.limit !== limit
      )
        throw new RiloomError("CURSOR_INVALIDATED", "列表已经变化，请重新读取");
      after = cursor.after;
    }
    const ordered = [...items].sort((a, b) =>
      idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0,
    );
    const remaining = ordered.filter((item) => idOf(item) > after),
      page = remaining.slice(0, limit);
    let nextCursor: string | null = null;
    if (remaining.length > limit) {
      const encoded = Buffer.from(
        JSON.stringify({
          generation: this.generation,
          scope,
          collection,
          version: collectionVersion,
          limit,
          after: idOf(page.at(-1)!),
        }),
      ).toString("base64url");
      nextCursor =
        encoded +
        "." +
        createHmac("sha256", this.cursorSecret)
          .update(encoded)
          .digest("base64url");
    }
    return { scope, collection, collectionVersion, items: page, nextCursor };
  }
}
