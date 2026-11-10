import { applyChanges } from "@riloom/core";
import {
  RiloomError,
  type BackupInfo,
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
            parameters = draft.changes.length
              ? applyChanges(this.base, draft.changes).model.parameters
              : this.base.parameters;
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
    this.publish({ selected: id });
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
  private edited(parameters: Parameter[]) {
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
    return result;
  }
  async save(): Promise<void> {
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
        else {
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
      this.acceptProject(project);
      this.edited([...parameters.values()]);
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
