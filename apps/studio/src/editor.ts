import { applyChanges, orderedDrawItems, canonicalJson } from "@riloom/core";
import {
  RiloomError,
  type BackupInfo,
  type Asset,
  type DrawItem,
  type BlobRef,
  type RestorePlan,
  type Candidate,
  type Change,
  type CommandRequest,
  type Draft,
  type Parameter,
  type ProjectModel,
  type ProjectState,
  type Receipt,
  type RegisteredProject,
} from "@riloom/contracts";

export interface EditorState {
  projects: RegisteredProject[];
  backups: BackupInfo[];
  recovering: boolean;
  backupMessage: string | null;
  project: ProjectState | null;
  parameters: Parameter[];
  assets: Asset[];
  drawItems: DrawItem[];
  selectedDrawing: string | null;
  selected: string | null;
  generation: number;
  savedGeneration: number;
  saving: boolean;
  applying: boolean;
  loading: boolean;
  rechecking: boolean;
  error: string | null;
}
const parameterFields = [
  "name",
  "unit",
  "min",
  "max",
  "default",
  "value",
] as const;
export type Execute = (request: CommandRequest) => Promise<Receipt>;
export class Editor {
  private state: EditorState = {
    projects: [],
    backups: [],
    recovering: false,
    backupMessage: null,
    project: null,
    parameters: [],
    assets: [],
    drawItems: [],
    selectedDrawing: null,
    selected: null,
    generation: 0,
    savedGeneration: 0,
    saving: false,
    applying: false,
    loading: false,
    rechecking: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private base: ProjectModel | null = null;
  private viewGeneration = 0;
  private opening = false;
  private baseRevision = 0;
  private baseHash: ProjectState["stateHash"] | null = null;
  private draftId: string = crypto.randomUUID();
  private draftVersion = 0;
  private readonly editorId: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private savePromise: Promise<void> | undefined;
  private pendingSave: CommandRequest | null = null;
  private pendingRestore: CommandRequest | null = null;
  private pendingImport: CommandRequest | null = null;
  private pendingApplication: {
    prepare: CommandRequest;
    apply?: CommandRequest;
  } | null = null;
  constructor(
    private readonly execute: Execute,
    readonly workspaceId: string,
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >,
  ) {
    this.editorId = storage.getItem("riloom.editor") ?? crypto.randomUUID();
    storage.setItem("riloom.editor", this.editorId);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(update: Partial<EditorState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private async call(
    command: string,
    args: Record<string, unknown>,
    projectId?: string,
    fields: Partial<CommandRequest> = {},
  ): Promise<Receipt> {
    const receipt = await this.execute({
      requestId: crypto.randomUUID(),
      command,
      commandVersion: "1.0.0",
      ...(projectId ? { projectId } : { workspaceId: this.workspaceId }),
      arguments: args,
      ...(projectId && this.state.project?.model.projectId === projectId
        ? { expectedStorageGeneration: this.state.project.storageGeneration }
        : {}),
      ...fields,
    });
    if (receipt.status === "failed")
      throw new RiloomError(
        receipt.error!.code,
        receipt.error!.message,
        receipt.error!.details,
      );
    return receipt;
  }
  async initialize(): Promise<void> {
    await this.refreshProjects();
    const selected = this.storage.getItem("riloom.project");
    if (
      selected &&
      this.state.projects.some((project) => project.projectId === selected)
    )
      await this.open(selected);
  }
  async refreshProjects(): Promise<void> {
    const projects: RegisteredProject[] = [];
    let cursor: string | null = null;
    do {
      const result = (
        await this.call("riloom.project.list", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
      ).result;
      projects.push(...(result.items as RegisteredProject[]));
      cursor = result.nextCursor as string | null;
    } while (cursor);
    this.publish({ projects });
  }
  async create(name: string, directory: string): Promise<void> {
    this.publish({ loading: true, error: null });
    try {
      const result = await this.call("riloom.project.create", {
        name,
        directory,
        canvas: { width: 1024, height: 1024 },
      });
      await this.refreshProjects();
      await this.open(result.result.projectId as string);
    } catch (error) {
      this.showError(error);
    } finally {
      this.publish({ loading: false });
    }
  }
  async open(projectId: string): Promise<void> {
    if (
      this.opening ||
      this.pendingImport ||
      this.state.applying ||
      this.state.rechecking ||
      this.state.recovering
    )
      return;
    this.opening = true;
    try {
      if (
        this.state.project &&
        this.state.generation > this.state.savedGeneration
      ) {
        await this.save();
        if (this.state.generation > this.state.savedGeneration) return;
      }
      this.publish({ loading: true, error: null });
      try {
        const project = (await this.call("riloom.project.open", { projectId }))
          .result.project as ProjectState;
        this.viewGeneration++;
        this.base = project.model;
        this.baseRevision = project.revision;
        this.baseHash = project.stateHash;
        this.draftId =
          this.storage.getItem("riloom.draft." + projectId) ??
          crypto.randomUUID();
        this.draftVersion = 0;
        let viewModel = project.model;
        let parameters = project.model.parameters,
          generation = 0;
        try {
          const result = (
            await this.call(
              "riloom.project.getDraft",
              { draftId: this.draftId },
              projectId,
            )
          ).result;
          const draft = result.draft as Draft;
          if (draft.draftStatus === "editing") {
            this.base = result.base as ProjectModel;
            this.baseRevision = draft.baseRevision;
            this.baseHash = draft.baseStateHash;
            viewModel = draft.changes.length
              ? applyChanges(this.base, draft.changes).model
              : this.base;
            parameters = viewModel.parameters;
            generation = draft.editGeneration;
            this.draftVersion = draft.draftVersion;
          } else this.draftId = crypto.randomUUID();
        } catch (error) {
          if (!(error instanceof RiloomError) || error.code !== "NOT_FOUND")
            throw error;
        }
        this.pendingSave = null;
        this.storage.setItem("riloom.project", projectId);
        this.storage.setItem("riloom.draft." + projectId, this.draftId);
        this.publish({
          project,
          parameters: structuredClone(parameters),
          assets: structuredClone(viewModel.assets ?? []),
          drawItems: structuredClone(viewModel.drawItems ?? []),
          selectedDrawing: null,
          selected: parameters[0]?.id ?? null,
          generation,
          savedGeneration: generation,
        });
      } catch (error) {
        this.showError(error);
      } finally {
        this.publish({ loading: false });
      }
    } finally {
      this.opening = false;
    }
  }
  select(id: string) {
    this.publish({ selected: id, selectedDrawing: null });
  }
  addParameter() {
    const parameter: Parameter = {
      id: crypto.randomUUID(),
      name: "参数 " + (this.state.parameters.length + 1),
      unit: "",
      min: -1,
      default: 0,
      max: 1,
      value: 0,
    };
    if (this.edited([...this.state.parameters, parameter]))
      this.publish({ selected: parameter.id });
  }
  updateParameter(id: string, update: Partial<Parameter>) {
    this.edited(
      this.state.parameters.map((parameter) =>
        parameter.id === id ? { ...parameter, ...update, id } : parameter,
      ),
    );
  }
  removeParameter(id: string) {
    if (
      this.edited(
        this.state.parameters.filter((parameter) => parameter.id !== id),
      )
    )
      this.publish({ selected: this.state.parameters[0]?.id ?? null });
  }
  private edited(
    parameters: Parameter[],
    assets = this.state.assets,
    drawItems = this.state.drawItems,
  ) {
    if (this.pendingImport) return false;
    if (
      this.state.loading ||
      this.state.recovering ||
      this.state.applying ||
      this.state.rechecking ||
      !this.state.project
    )
      return false;
    this.publish({
      parameters,
      assets,
      drawItems,
      generation: this.state.generation + 1,
      error: null,
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 650);
    return true;
  }
  changes(): Change[] {
    if (!this.base) return [];
    const result: Change[] = [],
      current = new Map(
        this.state.parameters.map((parameter) => [parameter.id, parameter]),
      );
    for (const before of this.base.parameters) {
      const after = current.get(before.id);
      if (!after) result.push({ type: "removeParameter", before });
      else if (
        parameterFields.some((key) => !Object.is(before[key], after[key]))
      )
        result.push({ type: "updateParameter", before, after });
    }
    const original = new Set(
      this.base.parameters.map((parameter) => parameter.id),
    );
    for (const after of this.state.parameters)
      if (!original.has(after.id)) result.push({ type: "addParameter", after });
    const beforeAssets = this.base.assets ?? [],
      beforeDrawings = this.base.drawItems ?? [];
    if (this.base.formatVersion === "1.0.0" && this.state.assets.length)
      result.unshift({ type: "setFormat", before: "1.0.0", after: "1.1.0" });
    for (const asset of this.state.assets)
      if (!beforeAssets.some((item) => item.id === asset.id))
        result.push({ type: "addAsset", after: asset });
    for (const before of beforeDrawings) {
      const after = this.state.drawItems.find((item) => item.id === before.id);
      if (!after) result.push({ type: "removeDrawItem", before });
      else if (JSON.stringify(before) !== JSON.stringify(after))
        result.push({ type: "updateDrawItem", before, after });
    }
    for (const after of this.state.drawItems)
      if (!beforeDrawings.some((item) => item.id === after.id))
        result.push({ type: "addDrawItem", after });
    return result;
  }
  selectDrawing(id: string) {
    this.publish({ selectedDrawing: id, selected: null });
  }
  updateDrawing(id: string, fields: Partial<DrawItem>) {
    this.edited(
      this.state.parameters,
      this.state.assets,
      this.state.drawItems.map((item) =>
        item.id === id
          ? {
              ...item,
              ...fields,
              id,
              assetId: item.assetId,
              orderToken: item.orderToken,
            }
          : item,
      ),
    );
  }
  removeDrawing(id: string) {
    if (
      this.edited(
        this.state.parameters,
        this.state.assets,
        this.state.drawItems.filter((item) => item.id !== id),
      )
    )
      this.publish({ selectedDrawing: null });
  }
  moveDrawing(id: string, direction: -1 | 1) {
    const sorted = orderedDrawItems(this.state.drawItems);
    const index = sorted.findIndex((item) => item.id === id),
      target = index + direction;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    const item = sorted[index]!;
    sorted.splice(index, 1);
    sorted.splice(target, 0, item);
    this.edited(
      this.state.parameters,
      this.state.assets,
      sorted.map((drawing, drawOrder) => ({ ...drawing, drawOrder })),
    );
  }
  get importPending() {
    return this.pendingImport !== null;
  }
  async importPng(name: string, pngBase64: string): Promise<void> {
    if (
      !this.state.project ||
      this.state.loading ||
      this.state.applying ||
      this.state.rechecking ||
      this.state.recovering ||
      this.pendingImport
    )
      return;
    await this.save();
    if (this.state.generation !== this.state.savedGeneration) return;
    this.pendingImport ??= {
      requestId: crypto.randomUUID(),
      command: "riloom.asset.import",
      commandVersion: "1.0.0",
      projectId: this.state.project.model.projectId,
      expectedDraftVersion: this.draftVersion,
      expectedStorageGeneration: this.state.project.storageGeneration,
      arguments: {
        name,
        pngBase64,
        draftId: this.draftId,
        editorId: this.editorId,
        baseRevision: this.baseRevision,
        baseStateHash: this.baseHash,
      },
    };
    await this.retryImport();
  }
  async retryImport(): Promise<void> {
    if (!this.pendingImport || !this.base) return;
    this.publish({ loading: true, error: null });
    try {
      const result = await this.execute(this.pendingImport);
      if (result.status === "failed")
        throw new RiloomError(
          result.error!.code,
          result.error!.message,
          result.error!.details,
        );
      const draft = result.result.draft as Draft;
      const model = applyChanges(this.base, draft.changes).model;
      this.draftVersion = draft.draftVersion;
      this.pendingImport = null;
      this.publish({
        parameters: model.parameters,
        assets: model.assets ?? [],
        drawItems: model.drawItems ?? [],
        selected: null,
        selectedDrawing: (result.result.drawing as DrawItem).id,
        generation: draft.editGeneration,
        savedGeneration: draft.editGeneration,
      });
    } catch (error) {
      if (error instanceof RiloomError && error.code !== "EFFECT_UNRESOLVED")
        this.pendingImport = null;
      this.showError(error);
    } finally {
      this.publish({ loading: false });
    }
  }
  async readPixels(reference: BlobRef, projectId: string): Promise<Uint8Array> {
    const output = new Uint8Array(reference.bytes);
    let offset = 0;
    while (offset < reference.bytes) {
      const result = (
        await this.call(
          "riloom.asset.read",
          { blob: reference, offset },
          projectId,
        )
      ).result;
      const chunk = Uint8Array.from(atob(result.data as string), (character) =>
        character.charCodeAt(0),
      );
      if (!chunk.length || offset + chunk.length > output.length)
        throw new Error("素材响应长度无效");
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
  async save(): Promise<void> {
    if (this.pendingImport) return;
    clearTimeout(this.timer);
    if (this.savePromise) return this.savePromise;
    const run = async () => {
      if (!this.state.project || !this.baseHash) return;
      this.publish({ saving: true });
      try {
        while (this.state.generation > this.state.savedGeneration) {
          const generation = this.state.generation;
          this.pendingSave ??= {
            requestId: crypto.randomUUID(),
            command: "riloom.project.saveDraft",
            commandVersion: "1.0.0",
            projectId: this.state.project!.model.projectId,
            expectedDraftVersion: this.draftVersion,
            expectedStorageGeneration: this.state.project!.storageGeneration,
            arguments: {
              draftId: this.draftId,
              editorId: this.editorId,
              baseRevision: this.baseRevision,
              baseStateHash: this.baseHash,
              editGeneration: generation,
              changes: this.changes(),
            },
          };
          const response = await this.execute(this.pendingSave);
          if (response.status === "failed") {
            this.pendingSave = null;
            throw new RiloomError(
              response.error!.code,
              response.error!.message,
              response.error!.details,
            );
          }
          const draft = response.result.draft as Draft;
          this.draftVersion = draft.draftVersion;
          this.pendingSave = null;
          this.publish({ savedGeneration: draft.editGeneration, error: null });
        }
      } catch (error) {
        if (error instanceof RiloomError && error.code !== "EFFECT_UNRESOLVED")
          this.pendingSave = null;
        this.showError(error);
      } finally {
        this.publish({ saving: false });
      }
    };
    this.savePromise = run();
    try {
      await this.savePromise;
    } finally {
      this.savePromise = undefined;
    }
  }
  async apply(): Promise<void> {
    if (
      !this.state.project ||
      this.pendingImport ||
      (!this.changes().length && !this.pendingApplication) ||
      this.state.applying
    )
      return;
    this.publish({ applying: true, error: null });
    try {
      if (!this.pendingApplication) {
        await this.save();
        if (this.state.generation !== this.state.savedGeneration) return;
        this.pendingApplication = {
          prepare: {
            requestId: crypto.randomUUID(),
            command: "riloom.project.prepareDraft",
            commandVersion: "1.0.0",
            projectId: this.state.project.model.projectId,
            expectedDraftVersion: this.draftVersion,
            expectedStorageGeneration: this.state.project!.storageGeneration,
            arguments: { draftId: this.draftId },
          },
        };
      }
      this.publish({ rechecking: true });
      if (!this.pendingApplication.apply) {
        const prepared = await this.execute(this.pendingApplication.prepare);
        if (prepared.status === "failed")
          throw new RiloomError(
            prepared.error!.code,
            prepared.error!.message,
            prepared.error!.details,
          );
        const candidate = prepared.result.candidate as Candidate;
        this.pendingApplication.apply = {
          requestId: crypto.randomUUID(),
          command: "riloom.project.apply",
          commandVersion: "1.0.0",
          projectId: this.state.project.model.projectId,
          expectedDraftVersion: this.draftVersion,
          expectedStorageGeneration: this.state.project!.storageGeneration,
          expectedRevision: this.state.project.revision,
          expectedStateHash: this.state.project.stateHash,
          arguments: {
            candidateId: candidate.candidateId,
            draftId: this.draftId,
          },
        };
      }
      const result = await this.execute(this.pendingApplication.apply);
      if (result.status === "failed")
        throw new RiloomError(
          result.error!.code,
          result.error!.message,
          result.error!.details,
        );
      this.pendingApplication = null;
      this.publish({ rechecking: false });
      this.acceptProject(result.result.project as ProjectState);
    } catch (error) {
      if (error instanceof RiloomError && error.code !== "EFFECT_UNRESOLVED") {
        this.pendingApplication = null;
        this.publish({ rechecking: false });
      }
      this.showError(error);
    } finally {
      this.publish({ applying: false });
    }
  }
  private acceptProject(project: ProjectState) {
    this.viewGeneration++;
    this.base = project.model;
    this.baseRevision = project.revision;
    this.baseHash = project.stateHash;
    this.draftId = crypto.randomUUID();
    this.draftVersion = 0;
    this.pendingSave = null;
    this.storage.setItem(
      "riloom.draft." + project.model.projectId,
      this.draftId,
    );
    this.publish({
      project,
      parameters: structuredClone(project.model.parameters),
      assets: structuredClone(project.model.assets ?? []),
      drawItems: structuredClone(project.model.drawItems ?? []),
      selectedDrawing: null,
      generation: 0,
      savedGeneration: 0,
      error: null,
    });
  }
  async refreshCurrent(): Promise<void> {
    if (!this.state.project || this.state.applying || this.state.loading)
      return;
    const view = this.viewGeneration,
      projectId = this.state.project.model.projectId;
    try {
      const project = (await this.call("riloom.project.get", {}, projectId))
        .result.project as ProjectState;
      if (
        view !== this.viewGeneration ||
        this.state.applying ||
        this.state.loading ||
        project.revision < this.state.project!.revision
      )
        return;
      if (project.storageGeneration !== this.state.project.storageGeneration) {
        this.publish({
          error: "工程已恢复到另一份存储。本次编辑已保留，请重新准备。",
        });
        return;
      }
      if (
        project.revision === this.state.project.revision &&
        project.revision === this.baseRevision
      )
        return;
      if (
        !this.changes().length &&
        !this.state.saving &&
        !this.state.rechecking &&
        this.state.generation === this.state.savedGeneration
      )
        this.acceptProject(project);
      else
        this.publish({
          project,
          error:
            "工程已由其他入口修改。本次草稿已保留，可基于当前工程重新准备。",
        });
    } catch (error) {
      this.showError(error);
    }
  }
  async rebase(): Promise<void> {
    if (
      !this.state.project ||
      !this.base ||
      this.state.applying ||
      this.state.rechecking ||
      this.state.loading
    )
      return;
    if (this.pendingImport) return;
    if (this.savePromise) await this.savePromise;
    const changes = this.changes();
    try {
      const project = (
        await this.call("riloom.project.open", {
          projectId: this.state.project.model.projectId,
        })
      ).result.project as ProjectState;
      const parameters = new Map(
        project.model.parameters.map((parameter) => [
          parameter.id,
          structuredClone(parameter),
        ]),
      );
      for (const change of changes) {
        if (change.type === "addParameter") {
          if (parameters.has(change.after.id))
            throw new RiloomError(
              "REVISION_CONFLICT",
              "新增参数与当前工程冲突",
            );
          parameters.set(change.after.id, change.after);
        } else if (change.type === "removeParameter")
          parameters.delete(change.before.id);
        else if (change.type === "updateParameter") {
          const current = parameters.get(change.before.id);
          if (!current)
            throw new RiloomError(
              "REVISION_CONFLICT",
              "本次编辑的参数已经删除",
            );
          for (const key of parameterFields) {
            if (change.before[key] !== change.after[key])
              Object.assign(current, { [key]: change.after[key] });
          }
        }
      }
      let rebased = { ...project.model, parameters: [...parameters.values()] };
      for (const change of changes) {
        if (
          change.type === "addParameter" ||
          change.type === "removeParameter" ||
          change.type === "updateParameter"
        )
          continue;
        if (
          change.type === "setFormat" &&
          rebased.formatVersion === change.after
        )
          continue;
        if (change.type === "addAsset") {
          const existing = rebased.assets?.find(
            (asset) => asset.id === change.after.id,
          );
          if (existing) {
            if (canonicalJson(existing) !== canonicalJson(change.after))
              throw new RiloomError(
                "REVISION_CONFLICT",
                "导入素材与当前工程冲突",
              );
            continue;
          }
        }
        if (change.type === "updateDrawItem") {
          const current = rebased.drawItems?.find(
            (item) => item.id === change.before.id,
          );
          if (!current)
            throw new RiloomError(
              "REVISION_CONFLICT",
              "本次编辑的绘画已经删除",
            );
          const after = { ...current };
          for (const key of [
            "name",
            "x",
            "y",
            "visible",
            "opacity",
            "drawOrder",
          ] as const)
            if (change.before[key] !== change.after[key])
              Object.assign(after, { [key]: change.after[key] });
          if (JSON.stringify(current) !== JSON.stringify(after))
            rebased = applyChanges(rebased, [
              { ...change, before: current, after },
            ]).model;
        } else {
          rebased = applyChanges(rebased, [change]).model;
        }
      }
      this.acceptProject(project);
      this.edited(
        rebased.parameters,
        rebased.assets ?? [],
        rebased.drawItems ?? [],
      );
      await this.save();
    } catch (error) {
      this.showError(error);
    }
  }
  async navigate(direction: "undo" | "redo"): Promise<void> {
    if (
      !this.state.project ||
      this.changes().length ||
      this.state.applying ||
      this.state.rechecking ||
      this.state.loading
    )
      return;
    await this.save();
    if (this.state.generation !== this.state.savedGeneration) return;
    this.publish({ applying: true, error: null });
    try {
      const project = this.state.project,
        group =
          direction === "undo" ? project.undoGroupId : project.redoGroupId;
      if (!group) return;
      const result = await this.call(
        "riloom.project." + direction,
        { undoGroupId: group },
        project.model.projectId,
        {
          expectedRevision: project.revision,
          expectedStateHash: project.stateHash,
          expectedHistoryVersion: project.historyVersion,
        },
      );
      this.acceptProject(result.result.project as ProjectState);
    } catch (error) {
      this.showError(error);
    } finally {
      this.publish({ applying: false });
    }
  }
  async refreshBackups(): Promise<void> {
    const backups: BackupInfo[] = [];
    let cursor: string | null = null;
    do {
      const receipt = await this.call("riloom.project.listBackups", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      backups.push(...(receipt.result.items as BackupInfo[]));
      cursor = receipt.result.nextCursor as string | null;
    } while (cursor);
    this.publish({ backups });
  }
  async backup(): Promise<void> {
    if (
      !this.state.project ||
      this.state.loading ||
      this.state.applying ||
      this.state.rechecking ||
      this.state.recovering
    )
      return;
    await this.save();
    if (this.state.generation !== this.state.savedGeneration) return;
    this.publish({ loading: true, error: null, backupMessage: null });
    try {
      const project = this.state.project;
      await this.call("riloom.project.backup", {
        projectId: project.model.projectId,
        expectedRevision: project.revision,
        expectedStateHash: project.stateHash,
        expectedStorageGeneration: project.storageGeneration,
      });
      await this.refreshBackups();
      this.publish({ backupMessage: "工程备份已保存" });
    } catch (error) {
      this.showError(error);
    } finally {
      this.publish({ loading: false });
    }
  }
  async importBackup(directory: string): Promise<void> {
    if (this.state.loading || this.state.recovering) return;
    this.publish({ loading: true, error: null, backupMessage: null });
    try {
      await this.call("riloom.project.importBackup", { directory });
      await this.refreshBackups();
      this.publish({ backupMessage: "备份已导入，可选择恢复" });
    } catch (error) {
      this.showError(error);
    } finally {
      this.publish({ loading: false });
    }
  }
  async restoreBackup(backupId: string, directory: string): Promise<void> {
    if (this.state.loading || this.state.applying || this.state.rechecking)
      return;
    if (!this.pendingRestore) {
      await this.save();
      if (this.state.generation !== this.state.savedGeneration) return;
    }
    this.publish({
      loading: true,
      recovering: true,
      error: null,
      backupMessage: null,
    });
    try {
      if (!this.pendingRestore) {
        const plan = (
          await this.call("riloom.project.prepareRestore", { backupId })
        ).result.plan as RestorePlan;
        this.pendingRestore = {
          requestId: crypto.randomUUID(),
          command: "riloom.project.restore",
          commandVersion: "1.0.0",
          workspaceId: this.workspaceId,
          arguments: {
            backupId,
            directory,
            ...(plan.expectedProject
              ? { expectedProject: plan.expectedProject }
              : {}),
          },
        };
      }
      const receipt = await this.execute(this.pendingRestore);
      if (receipt.status === "failed")
        throw new RiloomError(
          receipt.error!.code,
          receipt.error!.message,
          receipt.error!.details,
        );
      const projectId = (receipt.result.project as ProjectState).model
        .projectId;
      this.pendingRestore = null;
      this.publish({ recovering: false });
      await this.refreshProjects();
      await this.open(projectId);
      if (!this.state.error)
        this.publish({ backupMessage: "工程已恢复到新目录" });
    } catch (error) {
      if (error instanceof RiloomError && error.code !== "EFFECT_UNRESOLVED") {
        this.pendingRestore = null;
        this.publish({ recovering: false });
      }
      this.showError(error);
    } finally {
      this.publish({ loading: false });
    }
  }
  showError(error: unknown) {
    this.publish({
      error:
        error instanceof RiloomError
          ? error.message
          : "连接中断，草稿输入已保留，请重试保存。",
    });
  }
  dispose() {
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
