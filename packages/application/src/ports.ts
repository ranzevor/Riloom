import type {
  Candidate,
  Change,
  CommandRequest,
  Draft,
  ProjectModel,
  ProjectState,
  Receipt,
  RegisteredProject,
  StateHash,
} from "@riloom/contracts";
export interface HistoryGroup {
  id: string;
  ordinal: number;
  changes: Change[];
  inverse: Change[];
}
export interface ProjectTransaction {
  state(): ProjectState;
  events(
    after: number,
    limit: number,
  ): import("@riloom/contracts").ProjectEvent[];
  receiptById(operationId: string): Receipt | null;

  modelAt(revision: number): ProjectModel;
  draft(id: string): Draft | null;
  drafts(): Draft[];
  draftsVersion(): number;
  saveDraft(draft: Draft): void;
  candidate(id: string): Candidate | null;
  saveCandidate(candidate: Candidate): void;
  receipt(requestId: string): Receipt | null;
  saveReceipt(receipt: Receipt): void;
  addEvent(
    type: string,
    operationId: string,
    data: Record<string, unknown>,
  ): number;
  apply(
    model: ProjectModel,
    changes: Change[],
    inverse: Change[],
    operationId: string,
    navigation?: { direction: "undo" | "redo"; group: HistoryGroup },
  ): ProjectState;
  historyGroup(direction: "undo" | "redo"): HistoryGroup | null;
  atomic<T>(action: () => T): T;
}
export interface ProjectPersistence {
  read<T>(action: (transaction: ProjectTransaction) => T): T;
  write<T>(action: (transaction: ProjectTransaction) => T): T;
}
export interface CreateProjectInput {
  request: CommandRequest;
  inputHash: StateHash;
  operationId: string;
  model: ProjectModel;
  directory: string;
}
export interface WorkspacePersistence {
  readonly workspaceId: string;
  listProjects(): { version: number; items: RegisteredProject[] };
  receipt(requestId: string): Receipt | null;
  createProject(input: CreateProjectInput): Receipt;
  openProject(projectId: string): ProjectPersistence;
  projectGeneration(projectId: string): string;
  close(): void;
}
