import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  lstatSync,
  realpathSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  RiloomError,
  validateRequest,
  type BackupInfo,
  type RestoreExpectation,
  type RestorePlan,
  type Candidate,
  type Change,
  type Draft,
  type ProjectModel,
  type ProjectState,
  type Receipt,
  type RegisteredProject,
} from "@riloom/contracts";
import { applyChanges, canonicalJson, validateModel } from "@riloom/core";
import {
  hashValue,
  sameHash,
  type CreateProjectInput,
  type HistoryGroup,
  type ProjectPersistence,
  type ProjectTransaction,
  type WorkspacePersistence,
  type WorkspaceOperation,
} from "@riloom/application";
import {
  OwnerLock,
  identityLockDirectory,
  lockFilename,
  privateDirectory,
} from "@riloom/platform";

import {
  backupInfo,
  copyBackup,
  readBackup,
  writeManifest,
  type BackupManifest,
} from "./backup-files.js";

const applicationId = 0x52494c4d;
function parse<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new RiloomError("DATA_CORRUPT", "工程记录无法读取");
  }
}
function database(
  filename: string,
  initialize: boolean,
  maxVersion = 1,
  readOnly = false,
): DatabaseSync {
  if (!initialize && !existsSync(filename))
    throw new RiloomError("DATA_CORRUPT", "工程数据库缺失");
  if (
    existsSync(filename) &&
    (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
  )
    throw new RiloomError("PERMISSION_DENIED", "数据库必须为工程内的常规文件");
  const db = new DatabaseSync(filename, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;");
    const id = Number(
      (db.prepare("PRAGMA application_id").get() as { application_id: number })
        .application_id,
    );
    const schemaVersion = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (initialize && id === 0)
      db.exec(
        "PRAGMA application_id=" + applicationId + "; PRAGMA user_version=1;",
      );
    else {
      if (id !== applicationId || schemaVersion < 1)
        throw new RiloomError("DATA_CORRUPT", "文件不是 Riloom 数据库");
      if (schemaVersion > maxVersion)
        throw new RiloomError("UNSUPPORTED_VERSION", "数据库版本不受支持");
    }
    if (!readOnly) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const check = db.prepare("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    if (check.quick_check !== "ok")
      throw new RiloomError("DATA_CORRUPT", "数据库完整性检查失败");
    return db;
  } catch (error) {
    db.close();
    if (error instanceof RiloomError) throw error;
    throw new RiloomError("DATA_CORRUPT", "数据库无法读取");
  }
}
function transaction<T>(db: DatabaseSync, write: boolean, run: () => T): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function flushFile(filename: string): void {
  const fd = openSync(filename, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function flushDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
const projectSchema = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE objects (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE revisions (revision INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, forward TEXT NOT NULL, inverse TEXT NOT NULL);
CREATE TABLE drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE candidates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE operations (request_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, operation_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE history_groups (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, active INTEGER NOT NULL, changes TEXT NOT NULL, inverse TEXT NOT NULL);
`;
function initializeProject(filename: string, input: CreateProjectInput): void {
  const db = database(filename, true);
  try {
    transaction(db, true, () => {
      db.exec(projectSchema);
      const values: Record<string, unknown> = {
        model: { ...input.model, parameters: [] },
        revision: 0,
        stateHash: hashValue(input.model),
        storageGeneration: randomUUID(),
        creationOperationId: input.operationId,
        historyVersion: 0,
        historyCursor: 0,
        draftsVersion: 0,
      };
      for (const [key, value] of Object.entries(values))
        db.prepare("INSERT INTO meta VALUES (?,?)").run(
          key,
          canonicalJson(value),
        );
    });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  flushFile(filename);
}
class ProjectTransactionImpl implements ProjectTransaction {
  constructor(private readonly db: DatabaseSync) {}
  private get<T>(key: string): T {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(key) as { value: string } | undefined;
    if (!row) throw new RiloomError("DATA_CORRUPT", "工程元数据缺失");
    return parse<T>(row.value);
  }
  private set(key: string, value: unknown): void {
    this.db
      .prepare("UPDATE meta SET value=? WHERE key=?")
      .run(canonicalJson(value), key);
  }
  state(): ProjectState {
    const model = this.get<ProjectModel>("model");
    if (!model || typeof model !== "object")
      throw new RiloomError("DATA_CORRUPT", "工程模型记录损坏");
    model.parameters = (
      this.db.prepare("SELECT data FROM objects ORDER BY position").all() as {
        data: string;
      }[]
    ).map((row) => parse(row.data));
    try {
      validateModel(model);
    } catch {
      throw new RiloomError("DATA_CORRUPT", "工程参数记录损坏");
    }
    const stateHash = this.get<ProjectState["stateHash"]>("stateHash");
    if (!sameHash(hashValue(model), stateHash))
      throw new RiloomError("DATA_CORRUPT", "工程状态与记录不一致");
    const revision = this.get<number>("revision"),
      storageGeneration = this.get<string>("storageGeneration");
    for (const key of [
      "revision",
      "historyVersion",
      "historyCursor",
      "draftsVersion",
    ]) {
      const value = this.get<number>(key);
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RiloomError("DATA_CORRUPT", "工程版本记录无效");
    }
    if (
      typeof storageGeneration !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(storageGeneration) ||
      revision !==
        Number(
          (
            this.db
              .prepare(
                "SELECT COALESCE(MAX(revision),0) AS revision FROM revisions",
              )
              .get() as { revision: number }
          ).revision,
        )
    ) {
      throw new RiloomError("DATA_CORRUPT", "工程修订或存储世代记录无效");
    }
    return {
      model,
      revision,
      stateHash,
      storageGeneration,
      eventCursor: Number(
        (
          this.db
            .prepare("SELECT COALESCE(MAX(sequence),0) AS seq FROM events")
            .get() as { seq: number }
        ).seq,
      ),
      historyVersion: this.get("historyVersion"),
      undoGroupId: this.historyGroup("undo")?.id ?? null,
      redoGroupId: this.historyGroup("redo")?.id ?? null,
    };
  }
  requiresStorageGeneration(): boolean {
    return !!this.db
      .prepare("SELECT value FROM meta WHERE key='recoveryGeneration'")
      .get();
  }
  events(
    after: number,
    limit: number,
  ): import("@riloom/contracts").ProjectEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(after, limit) as {
        sequence: number;
        kind: string;
        operation_id: string;
        revision: number;
        data: string;
      }[]
    ).map((row) => ({
      projectId: this.get<ProjectModel>("model").projectId,
      sequence: row.sequence,
      type: row.kind,
      operationId: row.operation_id,
      revision: row.revision,
      data: parse(row.data),
    }));
  }
  receiptById(operationId: string): Receipt | null {
    const row = this.db
      .prepare(
        "SELECT data FROM operations WHERE json_extract(data, '$.operationId')=?",
      )
      .get(operationId) as { data: string } | undefined;
    return row ? parse(row.data) : null;
  }
  modelAt(revision: number): ProjectModel {
    const state = this.state();
    if (revision < 0 || revision > state.revision)
      throw new RiloomError("REVISION_CONFLICT", "工程基线修订不存在");
    let model = state.model;
    for (let current = state.revision; current > revision; current--) {
      const row = this.db
        .prepare("SELECT inverse FROM revisions WHERE revision=?")
        .get(current) as { inverse: string } | undefined;
      if (!row) throw new RiloomError("DATA_CORRUPT", "工程历史不完整");
      model = applyChanges(model, parse<Change[]>(row.inverse)).model;
    }
    return model;
  }
  draft(id: string): Draft | null {
    const row = this.db
      .prepare("SELECT data FROM drafts WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? parse(row.data) : null;
  }
  drafts(): Draft[] {
    return (
      this.db.prepare("SELECT data FROM drafts ORDER BY id").all() as {
        data: string;
      }[]
    ).map((row) => parse(row.data));
  }
  draftsVersion(): number {
    return this.get("draftsVersion");
  }
  saveDraft(draft: Draft): void {
    this.db
      .prepare(
        "INSERT INTO drafts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(draft.draftId, canonicalJson(draft));
    this.set("draftsVersion", this.draftsVersion() + 1);
  }
  candidate(id: string): Candidate | null {
    const row = this.db
      .prepare("SELECT data FROM candidates WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? parse(row.data) : null;
  }
  saveCandidate(candidate: Candidate): void {
    this.db
      .prepare(
        "INSERT INTO candidates VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(candidate.candidateId, canonicalJson(candidate));
  }
  receipt(requestId: string): Receipt | null {
    const row = this.db
      .prepare("SELECT data FROM operations WHERE request_id=?")
      .get(requestId) as { data: string } | undefined;
    return row ? parse(row.data) : null;
  }
  saveReceipt(receipt: Receipt): void {
    this.db
      .prepare("INSERT INTO operations VALUES (?,?)")
      .run(receipt.requestId, canonicalJson(receipt));
  }
  addEvent(
    type: string,
    operationId: string,
    data: Record<string, unknown>,
  ): number {
    const result = this.db
      .prepare(
        "INSERT INTO events(kind,operation_id,revision,data) VALUES (?,?,?,?)",
      )
      .run(
        type,
        operationId,
        this.get<number>("revision"),
        canonicalJson(data),
      );
    return Number(result.lastInsertRowid);
  }
  historyGroup(direction: "undo" | "redo"): HistoryGroup | null {
    const cursor = this.get<number>("historyCursor");
    const row = this.db
      .prepare(
        direction === "undo"
          ? "SELECT * FROM history_groups WHERE active=1 AND ordinal=?"
          : "SELECT * FROM history_groups WHERE active=1 AND ordinal>? ORDER BY ordinal LIMIT 1",
      )
      .get(cursor) as
      | { id: string; ordinal: number; changes: string; inverse: string }
      | undefined;
    return row
      ? {
          id: row.id,
          ordinal: row.ordinal,
          changes: parse(row.changes),
          inverse: parse(row.inverse),
        }
      : null;
  }
  apply(
    model: ProjectModel,
    changes: Change[],
    inverse: Change[],
    operationId: string,
    navigation?: { direction: "undo" | "redo"; group: HistoryGroup },
  ): ProjectState {
    validateModel(model);
    const revision = this.get<number>("revision") + 1;
    this.db.exec("DELETE FROM objects");
    for (const [index, parameter] of model.parameters.entries())
      this.db
        .prepare("INSERT INTO objects VALUES (?,?,?)")
        .run(parameter.id, index, canonicalJson(parameter));
    this.set("model", { ...model, parameters: [] });
    this.set("revision", revision);
    this.set("stateHash", hashValue(model));
    this.db
      .prepare("INSERT INTO revisions VALUES (?,?,?,?)")
      .run(
        revision,
        operationId,
        canonicalJson(changes),
        canonicalJson(inverse),
      );
    if (navigation) {
      const cursor =
        navigation.direction === "redo"
          ? navigation.group.ordinal
          : Number(
              (
                this.db
                  .prepare(
                    "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM history_groups WHERE active=1 AND ordinal<?",
                  )
                  .get(navigation.group.ordinal) as { ordinal: number }
              ).ordinal,
            );
      this.set("historyCursor", cursor);
    } else {
      this.db
        .prepare("UPDATE history_groups SET active=0 WHERE ordinal>?")
        .run(this.get<number>("historyCursor"));
      const ordinal = Number(
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM history_groups",
            )
            .get() as { ordinal: number }
        ).ordinal,
      );
      this.db
        .prepare("INSERT INTO history_groups VALUES (?,?,1,?,?)")
        .run(
          randomUUID(),
          ordinal,
          canonicalJson(changes),
          canonicalJson(inverse),
        );
      this.set("historyCursor", ordinal);
    }
    this.set("historyVersion", this.get<number>("historyVersion") + 1);
    this.addEvent(
      navigation ? "project." + navigation.direction : "project.changed",
      operationId,
      { revision },
    );
    return this.state();
  }
  atomic<T>(run: () => T): T {
    this.db.exec("SAVEPOINT effect");
    try {
      const result = run();
      this.db.exec("RELEASE effect");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO effect; RELEASE effect");
      throw error;
    }
  }
}
function validateStoredProject(db: DatabaseSync): ProjectState {
  try {
    const expectedTables = [
      "candidates",
      "drafts",
      "events",
      "history_groups",
      "meta",
      "objects",
      "operations",
      "revisions",
    ];
    const definitions = db
      .prepare(
        "SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      )
      .all() as { type: string; name: string }[];
    if (
      definitions.some(
        (item) => item.type !== "table" || !expectedTables.includes(item.name),
      ) ||
      definitions.length !== expectedTables.length
    ) {
      throw new RiloomError("DATA_CORRUPT", "工程数据表结构无效");
    }
    const tx = new ProjectTransactionImpl(db),
      state = tx.state();
    const rows = db
      .prepare(
        "SELECT revision,forward,inverse FROM revisions ORDER BY revision",
      )
      .all() as { revision: number; forward: string; inverse: string }[];
    if (rows.length !== state.revision)
      throw new RiloomError("DATA_CORRUPT", "工程历史修订不完整");
    const models = new Map<number, ProjectModel>([
      [state.revision, state.model],
    ]);
    let current = state.model;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!;
      if (row.revision !== index + 1)
        throw new RiloomError("DATA_CORRUPT", "工程历史修订不连续");
      const previous = applyChanges(
        current,
        parse<Change[]>(row.inverse),
      ).model;
      if (
        canonicalJson(
          applyChanges(previous, parse<Change[]>(row.forward)).model,
        ) !== canonicalJson(current)
      )
        throw new RiloomError("DATA_CORRUPT", "工程历史正逆操作不一致");
      models.set(index, previous);
      current = previous;
    }
    const validateChanges = (
      revision: number,
      stateHash: ProjectState["stateHash"],
      changes: Change[],
      inverse: Change[],
    ) => {
      const model = models.get(revision);
      if (!model || !sameHash(hashValue(model), stateHash))
        throw new RiloomError("DATA_CORRUPT", "编辑来源与工程历史不一致");
      const calculated = changes.length
        ? applyChanges(model, changes).inverse
        : [];
      if (canonicalJson(calculated) !== canonicalJson(inverse))
        throw new RiloomError("DATA_CORRUPT", "编辑逆操作不一致");
    };
    const drafts = tx.drafts();
    for (const draft of drafts) {
      validateRequest({
        requestId: "validate-draft",
        command: "riloom.project.saveDraft",
        commandVersion: "1.0.0",
        projectId: state.model.projectId,
        expectedDraftVersion: 0,
        arguments: {
          draftId: draft.draftId,
          editorId: draft.editorId,
          baseRevision: draft.baseRevision,
          baseStateHash: draft.baseStateHash,
          editGeneration: draft.editGeneration,
          changes: draft.changes,
        },
      });
      if (
        draft.projectId !== state.model.projectId ||
        !Number.isSafeInteger(draft.draftVersion) ||
        draft.draftVersion < 1 ||
        !["editing", "applied", "discarded"].includes(draft.draftStatus)
      )
        throw new RiloomError("DATA_CORRUPT", "草稿状态无效");
      validateChanges(
        draft.baseRevision,
        draft.baseStateHash,
        draft.changes,
        draft.inverseChanges,
      );
    }
    for (const row of db.prepare("SELECT data FROM candidates").all() as {
      data: string;
    }[]) {
      const candidate = parse<Candidate>(row.data),
        draft = drafts.find((item) => item.draftId === candidate.draftId);
      if (
        !draft ||
        !Number.isSafeInteger(candidate.draftVersion) ||
        candidate.draftVersion < 1 ||
        candidate.draftVersion > draft.draftVersion ||
        !["ready", "applied"].includes(candidate.status)
      )
        throw new RiloomError("DATA_CORRUPT", "候选状态无效");
      validateChanges(
        candidate.sourceRevision,
        candidate.sourceStateHash,
        candidate.changes,
        candidate.inverseChanges,
      );
    }
    for (const row of db
      .prepare("SELECT request_id,data FROM operations")
      .all() as { request_id: string; data: string }[]) {
      const receipt = parse<Receipt>(row.data);
      if (
        receipt.requestId !== row.request_id ||
        receipt.scope.projectId !== state.model.projectId ||
        !["succeeded", "failed"].includes(receipt.status) ||
        !sameHash(receipt.inputHash, receipt.inputHash) ||
        !/^[a-f0-9]{64}$/.test(receipt.inputHash.digest)
      )
        throw new RiloomError("DATA_CORRUPT", "工程回执记录无效");
    }
    for (const row of db
      .prepare("SELECT changes,inverse FROM history_groups")
      .all() as { changes: string; inverse: string }[]) {
      if (
        !rows.some(
          (revision) =>
            revision.forward === row.changes &&
            revision.inverse === row.inverse,
        )
      )
        throw new RiloomError("DATA_CORRUPT", "撤销历史与修订记录不一致");
    }
    return state;
  } catch (error) {
    if (
      error instanceof RiloomError &&
      (error.code === "DATA_CORRUPT" || error.code === "UNSUPPORTED_VERSION")
    )
      throw error;
    throw new RiloomError("DATA_CORRUPT", "工程备份中的数据或历史无效");
  }
}

class ProjectDatabase implements ProjectPersistence {
  readonly db: DatabaseSync;
  readonly lock: OwnerLock;
  constructor(
    directory: string,
    projectId: string,
    lockDirectory: string,
    private readonly checkpoint?: StorageOptions["checkpoint"],
    heldLock?: OwnerLock,
  ) {
    if (lstatSync(directory).isSymbolicLink())
      throw new RiloomError("PERMISSION_DENIED", "工程目录不能为符号链接");
    this.lock =
      heldLock ??
      new OwnerLock(lockFilename(lockDirectory, "project:" + projectId), {
        pid: process.pid,
        generation: randomUUID(),
        endpoint: "",
      });
    let opened: DatabaseSync | undefined;
    try {
      this.db = opened = database(
        path.join(directory, "project.sqlite"),
        false,
      );
      if (this.read((tx) => tx.state().model.projectId) !== projectId)
        throw new RiloomError("DATA_CORRUPT", "工程目录身份不符");
    } catch (error) {
      opened?.close();
      this.lock.close();
      throw error;
    }
  }
  read<T>(run: (tx: ProjectTransaction) => T): T {
    return transaction(this.db, false, () =>
      run(new ProjectTransactionImpl(this.db)),
    );
  }
  write<T>(run: (tx: ProjectTransaction) => T): T {
    return transaction(this.db, true, () => {
      const result = run(new ProjectTransactionImpl(this.db));
      this.checkpoint?.("before-project-commit");
      return result;
    });
  }
  close(): void {
    this.db.close();
    this.lock.close();
  }
}
interface Intent extends CreateProjectInput {
  stage: string;
}
interface BackupIntent extends WorkspaceOperation {
  kind: "create" | "import" | "restore";
  projectId: string;
  backupId: string;
  createdAt: string;
  stage: string;
  generation: string;
  source?: string;
  sourceHash?: ProjectState["stateHash"];
  directory?: string;
  expectedProject?: RestoreExpectation;
}
export interface StorageOptions {
  lockDirectory?: string;
  checkpoint?: (
    point:
      | "create-intent"
      | "project-ready"
      | "project-published"
      | "before-project-commit"
      | "backup-intent"
      | "backup-copied"
      | "backup-published"
      | "backup-registered"
      | "restore-intent"
      | "restore-copied"
      | "restore-published"
      | "restore-registered",
  ) => void;
}
export class SQLiteWorkspace implements WorkspacePersistence {
  readonly workspaceId: string;
  private readonly db: DatabaseSync;
  private readonly opened = new Map<string, ProjectDatabase>();
  private readonly lockDirectory: string;
  private readonly staging: string;
  private readonly backupsDirectory: string;
  readonly root: string;
  constructor(
    directory: string,
    private readonly options: StorageOptions = {},
  ) {
    mkdirSync(directory, { recursive: true });
    this.root = realpathSync(directory);
    const internal = privateDirectory(path.join(this.root, ".riloom"));
    this.staging = privateDirectory(path.join(internal, "staging"));
    this.backupsDirectory = privateDirectory(path.join(internal, "backups"));
    this.lockDirectory = options.lockDirectory
      ? privateDirectory(options.lockDirectory)
      : identityLockDirectory();
    const filename = path.join(this.root, "workspace.sqlite"),
      fresh = !existsSync(filename);
    this.db = database(filename, fresh, 2);
    try {
      if (fresh)
        transaction(this.db, true, () => {
          this.db.exec(
            "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE projects(id TEXT PRIMARY KEY,directory TEXT NOT NULL UNIQUE,name TEXT NOT NULL,generation TEXT NOT NULL); CREATE TABLE operations(request_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE intents(request_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,data TEXT NOT NULL);",
          );
          this.db
            .prepare("INSERT INTO meta VALUES ('workspaceId',?)")
            .run(randomUUID());
        });
      if (
        (
          this.db.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version === 1
      )
        transaction(this.db, true, () => {
          this.db.exec(
            "ALTER TABLE projects ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1; CREATE TABLE backups(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE backup_intents(request_id TEXT PRIMARY KEY, data TEXT NOT NULL);",
          );
          this.db
            .prepare("INSERT INTO meta VALUES ('projectsVersion',?)")
            .run(
              String(
                (
                  this.db
                    .prepare("SELECT COUNT(*) AS count FROM projects")
                    .get() as { count: number }
                ).count,
              ),
            );
          this.db.exec(
            "INSERT INTO meta VALUES ('backupsVersion','0'); PRAGMA user_version=2;",
          );
        });
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key='workspaceId'")
        .get() as { value: string } | undefined;
      if (!row) throw new RiloomError("DATA_CORRUPT", "工作区身份记录缺失");
      this.workspaceId = row.value;
      for (const pending of this.db
        .prepare("SELECT data FROM intents")
        .all() as { data: string }[])
        this.finish(parse<Intent>(pending.data), true);
      for (const pending of this.db
        .prepare("SELECT data FROM backup_intents")
        .all() as { data: string }[])
        this.finishBackup(parse<BackupIntent>(pending.data));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  listProjects(): { version: number; items: RegisteredProject[] } {
    return transaction(this.db, false, () => ({
      version: Number(
        (
          this.db
            .prepare("SELECT value FROM meta WHERE key='projectsVersion'")
            .get() as { value: string }
        ).value,
      ),
      items: (
        this.db.prepare("SELECT * FROM projects ORDER BY id").all() as {
          id: string;
          directory: string;
          name: string;
          generation: string;
          record_version: number;
        }[]
      ).map((row) => ({
        projectId: row.id,
        directory: row.directory,
        name: row.name,
        storageGeneration: row.generation,
        recordVersion: row.record_version,
      })),
    }));
  }
  receipt(requestId: string): Receipt | null {
    const row = this.db
      .prepare("SELECT data FROM operations WHERE request_id=?")
      .get(requestId) as { data: string } | undefined;
    return row ? parse(row.data) : null;
  }
  private target(directory: string): string {
    if (
      !directory.endsWith(".riloom") ||
      directory === ".riloom" ||
      /[\\/:*?"<>|\p{Cc}]/u.test(directory) ||
      /[. ]$/.test(directory) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(directory)
    )
      throw new RiloomError(
        "INVALID_INPUT",
        "工程目录必须是以 .riloom 结尾的单级目录名",
      );
    return path.join(this.root, directory);
  }
  createProject(input: CreateProjectInput): Receipt {
    const previous = this.receipt(input.request.requestId);
    if (previous) {
      if (!sameHash(previous.inputHash, input.inputHash))
        throw new RiloomError("REQUEST_ID_REUSED", "请求标识已用于另一组输入");
      return previous;
    }
    const pending = this.db
      .prepare("SELECT data FROM intents WHERE request_id=?")
      .get(input.request.requestId) as { data: string } | undefined;
    if (pending) {
      const intent = parse<Intent>(pending.data);
      if (!sameHash(intent.inputHash, input.inputHash))
        throw new RiloomError("REQUEST_ID_REUSED", "请求标识已用于另一组输入");
      return this.finish(intent, true);
    }
    const target = this.target(input.directory);
    if (
      existsSync(target) &&
      (lstatSync(target).isSymbolicLink() ||
        !lstatSync(target).isDirectory() ||
        readdirSync(target).length !== 0)
    )
      throw new RiloomError("RESOURCE_BUSY", "目标目录已包含内容");
    const intent: Intent = {
      ...input,
      stage: path.join(this.staging, input.operationId),
    };
    transaction(this.db, true, () =>
      this.db
        .prepare("INSERT INTO intents VALUES (?,?)")
        .run(input.request.requestId, canonicalJson(intent)),
    );
    this.options.checkpoint?.("create-intent");
    return this.finish(intent, false);
  }
  private removeStage(intent: Pick<Intent, "stage" | "operationId">): void {
    if (!existsSync(intent.stage)) return;
    if (
      path.dirname(realpathSync(intent.stage)) !== this.staging ||
      path.basename(intent.stage) !== intent.operationId ||
      readFileSync(path.join(intent.stage, ".owner"), "utf8") !==
        intent.operationId
    )
      throw new RiloomError("DATA_CORRUPT", "中间目录归属不符");
    rmSync(intent.stage, { recursive: true });
  }
  private finish(intent: Intent, recovering: boolean): Receipt {
    const target = this.target(intent.directory);
    if (intent.stage !== path.join(this.staging, intent.operationId))
      throw new RiloomError("DATA_CORRUPT", "中间目录记录无效");
    try {
      if (!existsSync(path.join(target, "project.sqlite"))) {
        if (!recovering) {
          mkdirSync(intent.stage, { mode: 0o700 });
          writeFileSync(path.join(intent.stage, ".owner"), intent.operationId, {
            flag: "wx",
          });
          mkdirSync(path.join(intent.stage, "assets"));
          mkdirSync(path.join(intent.stage, "artifacts"));
          mkdirSync(path.join(intent.stage, "staging"));
          initializeProject(path.join(intent.stage, "project.sqlite"), intent);
          this.options.checkpoint?.("project-ready");
        }
        if (!existsSync(path.join(intent.stage, "project.sqlite")))
          throw new RiloomError("DATA_CORRUPT", "工程初始化中断，创建未完成");
        if (existsSync(target)) {
          if (
            lstatSync(target).isSymbolicLink() ||
            !lstatSync(target).isDirectory() ||
            readdirSync(target).length
          )
            throw new RiloomError(
              "RESOURCE_BUSY",
              "目标目录在创建期间发生变化",
            );
          rmdirSync(target);
        }
        renameSync(intent.stage, target);
        flushDirectory(this.root);
        this.options.checkpoint?.("project-published");
      }
      if (lstatSync(target).isSymbolicLink())
        throw new RiloomError("PERMISSION_DENIED", "工程目录不能为符号链接");
      const project = database(path.join(target, "project.sqlite"), false);
      let state: ProjectState;
      try {
        const operation = project
          .prepare("SELECT value FROM meta WHERE key='creationOperationId'")
          .get() as { value: string };
        if (!operation || parse<string>(operation.value) !== intent.operationId)
          throw new RiloomError("RESOURCE_BUSY", "目标目录属于另一项创建操作");
        state = transaction(project, false, () =>
          new ProjectTransactionImpl(project).state(),
        );
        if (state.model.projectId !== intent.model.projectId)
          throw new RiloomError("DATA_CORRUPT", "新工程身份不符");
      } finally {
        project.close();
      }
      const marker = path.join(target, ".owner");
      if (
        existsSync(marker) &&
        readFileSync(marker, "utf8") === intent.operationId
      )
        unlinkSync(marker);
      return transaction(this.db, true, () => {
        this.db
          .prepare(
            "INSERT INTO projects (id,directory,name,generation) VALUES (?,?,?,?)",
          )
          .run(
            state.model.projectId,
            intent.directory,
            state.model.name,
            state.storageGeneration,
          );
        this.advanceCollection("projectsVersion");
        const sequence = Number(
          this.db
            .prepare("INSERT INTO events(operation_id,data) VALUES (?,?)")
            .run(
              intent.operationId,
              canonicalJson({ projectId: state.model.projectId }),
            ).lastInsertRowid,
        );
        const receipt: Receipt = {
          operationId: intent.operationId,
          requestId: intent.request.requestId,
          command: intent.request.command,
          commandVersion: intent.request.commandVersion,
          scope: { workspaceId: this.workspaceId },
          status: "succeeded",
          inputHash: intent.inputHash,
          result: {
            projectId: state.model.projectId,
            initialRevision: 0,
            stateHash: state.stateHash,
            storageGeneration: state.storageGeneration,
          },
          artifactRefs: [],
          eventCursor: sequence,
        };
        this.db
          .prepare("INSERT INTO operations VALUES (?,?)")
          .run(receipt.requestId, canonicalJson(receipt));
        this.db
          .prepare("DELETE FROM intents WHERE request_id=?")
          .run(receipt.requestId);
        return receipt;
      });
    } catch (error) {
      if (!(error instanceof RiloomError)) throw error;
      const receipt: Receipt = {
        operationId: intent.operationId,
        requestId: intent.request.requestId,
        command: intent.request.command,
        commandVersion: intent.request.commandVersion,
        scope: { workspaceId: this.workspaceId },
        status: "failed",
        inputHash: intent.inputHash,
        result: {},
        artifactRefs: [],
        eventCursor: 0,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      };
      transaction(this.db, true, () => {
        this.db
          .prepare("INSERT INTO operations VALUES (?,?)")
          .run(receipt.requestId, canonicalJson(receipt));
        this.db
          .prepare("DELETE FROM intents WHERE request_id=?")
          .run(receipt.requestId);
      });
      this.removeStage(intent);
      return receipt;
    }
  }
  private advanceCollection(key: "projectsVersion" | "backupsVersion"): void {
    this.db
      .prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key=?")
      .run(key);
  }
  listBackups(projectId?: string): { version: number; items: BackupInfo[] } {
    return transaction(this.db, false, () => {
      const rows = projectId
        ? this.db
            .prepare("SELECT data FROM backups WHERE project_id=? ORDER BY id")
            .all(projectId)
        : this.db.prepare("SELECT data FROM backups ORDER BY id").all();
      return {
        version: Number(
          (
            this.db
              .prepare("SELECT value FROM meta WHERE key='backupsVersion'")
              .get() as { value: string }
          ).value,
        ),
        items: (rows as { data: string }[]).map((row) =>
          parse<BackupInfo>(row.data),
        ),
      };
    });
  }
  private storedBackup(backupId: string): BackupInfo {
    const row = this.db
      .prepare("SELECT data FROM backups WHERE id=?")
      .get(backupId) as { data: string } | undefined;
    if (!row) throw new RiloomError("NOT_FOUND", "备份不存在");
    const info = parse<BackupInfo>(row.data);
    if (
      info.directory !==
      path.join(this.backupsDirectory, backupId + ".riloombackup")
    )
      throw new RiloomError("DATA_CORRUPT", "备份登记位置无效");
    return info;
  }
  private backupState(directory: string): {
    manifest: BackupManifest;
    state: ProjectState;
  } {
    const manifest = readBackup(directory),
      db = database(path.join(directory, "project.sqlite"), false, 1, true);
    try {
      const state = transaction(db, false, () => validateStoredProject(db));
      if (
        state.model.projectId !== manifest.projectId ||
        state.model.name !== manifest.projectName ||
        state.revision !== manifest.revision ||
        !sameHash(state.stateHash, manifest.stateHash)
      )
        throw new RiloomError("DATA_CORRUPT", "备份清单与工程内容不一致");
      return { manifest, state };
    } finally {
      db.close();
    }
  }
  private registration(
    projectId: string,
  ):
    | { directory: string; generation: string; record_version: number }
    | undefined {
    return this.db
      .prepare(
        "SELECT directory,generation,record_version FROM projects WHERE id=?",
      )
      .get(projectId) as
      | { directory: string; generation: string; record_version: number }
      | undefined;
  }
  private recoveryStatus(projectId: string): Omit<RestorePlan, "backup"> {
    const row = this.registration(projectId);
    if (!row) return { currentStatus: "unregistered" };
    const expectedProject: RestoreExpectation = {
      storageGeneration: row.generation,
    };
    let db: DatabaseSync | undefined;
    try {
      db = database(
        path.join(this.target(row.directory), "project.sqlite"),
        false,
        1,
        true,
      );
      const state = transaction(db, false, () =>
        new ProjectTransactionImpl(db!).state(),
      );
      if (state.storageGeneration !== row.generation)
        throw new RiloomError("DATA_CORRUPT", "工程存储世代与登记不一致");
      return {
        currentStatus: "registered",
        expectedProject: {
          ...expectedProject,
          revision: state.revision,
          stateHash: state.stateHash,
        },
      };
    } catch (error) {
      if (error instanceof RiloomError && error.code === "DATA_CORRUPT")
        return { currentStatus: "damaged", expectedProject };
      throw error;
    } finally {
      db?.close();
    }
  }
  prepareRestore(backupId: string): RestorePlan {
    const backup = this.storedBackup(backupId);
    const checked = this.backupState(backup.directory);
    if (
      canonicalJson(backupInfo(backup.directory, checked.manifest)) !==
      canonicalJson(backup)
    )
      throw new RiloomError("DATA_CORRUPT", "备份内容与登记不一致");
    return { backup, ...this.recoveryStatus(backup.projectId) };
  }
  private checkRestore(intent: BackupIntent): void {
    const current = this.recoveryStatus(intent.projectId);
    if (
      canonicalJson(current.expectedProject ?? null) !==
      canonicalJson(intent.expectedProject ?? null)
    ) {
      throw new RiloomError(
        "REVISION_CONFLICT",
        "工程已变化，请重新核对恢复内容",
      );
    }
  }
  manageBackup(input: WorkspaceOperation): Receipt {
    const previous = this.receipt(input.request.requestId);
    if (previous) {
      if (!sameHash(previous.inputHash, input.inputHash))
        throw new RiloomError("REQUEST_ID_REUSED", "请求标识已用于另一组输入");
      return previous;
    }
    const pending = this.db
      .prepare("SELECT data FROM backup_intents WHERE request_id=?")
      .get(input.request.requestId) as { data: string } | undefined;
    if (pending) {
      const intent = parse<BackupIntent>(pending.data);
      if (!sameHash(intent.inputHash, input.inputHash))
        throw new RiloomError("REQUEST_ID_REUSED", "请求标识已用于另一组输入");
      return this.finishBackup(intent);
    }
    const args = input.request.arguments;
    try {
      const kind =
        input.request.command === "riloom.project.backup"
          ? "create"
          : input.request.command === "riloom.project.importBackup"
            ? "import"
            : "restore";
      let projectId: string, backupId: string;
      if (kind === "create") {
        projectId = args.projectId as string;
        backupId = randomUUID();
      } else {
        const info =
          kind === "import"
            ? this.backupState(path.resolve(args.directory as string)).manifest
            : this.storedBackup(args.backupId as string);
        projectId = info.projectId;
        backupId = info.backupId;
      }
      const intent: BackupIntent = {
        ...input,
        kind,
        projectId,
        backupId,
        createdAt: new Date().toISOString(),
        stage: path.join(this.staging, input.operationId),
        generation: randomUUID(),
        ...(kind === "import"
          ? {
              source: path.resolve(args.directory as string),
              sourceHash: hashValue(
                this.backupState(path.resolve(args.directory as string))
                  .manifest,
              ),
            }
          : {}),
        ...(kind === "restore"
          ? {
              directory: args.directory as string,
              ...(args.expectedProject
                ? {
                    expectedProject: args.expectedProject as RestoreExpectation,
                  }
                : {}),
            }
          : {}),
      };
      if (kind === "restore") {
        this.checkRestore(intent);
        if (existsSync(this.target(intent.directory!)))
          throw new RiloomError(
            "RESOURCE_BUSY",
            "恢复目录已经存在，请选择新目录",
          );
      }
      transaction(this.db, true, () =>
        this.db
          .prepare("INSERT INTO backup_intents VALUES (?,?)")
          .run(input.request.requestId, canonicalJson(intent)),
      );
      this.options.checkpoint?.(
        kind === "restore" ? "restore-intent" : "backup-intent",
      );
      return this.finishBackup(intent);
    } catch (error) {
      if (!(error instanceof RiloomError)) throw error;
      return this.backupFailure(input, error);
    }
  }
  private backupFailure(
    input: WorkspaceOperation,
    error: RiloomError,
  ): Receipt {
    const prior = this.receipt(input.request.requestId);
    if (prior) return prior;
    const receipt: Receipt = {
      operationId: input.operationId,
      requestId: input.request.requestId,
      command: input.request.command,
      commandVersion: input.request.commandVersion,
      scope: { workspaceId: this.workspaceId },
      status: "failed",
      inputHash: input.inputHash,
      result: {},
      artifactRefs: [],
      eventCursor: 0,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
    transaction(this.db, true, () => {
      this.db
        .prepare("INSERT INTO operations VALUES (?,?)")
        .run(receipt.requestId, canonicalJson(receipt));
      this.db
        .prepare("DELETE FROM backup_intents WHERE request_id=?")
        .run(receipt.requestId);
    });
    return receipt;
  }
  private prepareBackupStage(intent: BackupIntent): string {
    if (intent.stage !== path.join(this.staging, intent.operationId))
      throw new RiloomError("DATA_CORRUPT", "备份中间目录无效");
    if (!existsSync(intent.stage)) {
      mkdirSync(intent.stage);
      writeFileSync(path.join(intent.stage, ".owner"), intent.operationId, {
        flag: "wx",
      });
      mkdirSync(path.join(intent.stage, "content"));
    }
    if (
      lstatSync(intent.stage).isSymbolicLink() ||
      readFileSync(path.join(intent.stage, ".owner"), "utf8") !==
        intent.operationId
    )
      throw new RiloomError("DATA_CORRUPT", "备份中间目录归属无效");
    return path.join(intent.stage, "content");
  }
  private clearBackupStage(intent: BackupIntent): void {
    if (existsSync(intent.stage)) this.removeStage(intent);
  }
  private finishBackup(intent: BackupIntent): Receipt {
    let lock: OwnerLock | undefined, restored: ProjectDatabase | undefined;
    try {
      const target =
        intent.kind === "restore"
          ? this.target(intent.directory!)
          : path.join(this.backupsDirectory, intent.backupId + ".riloombackup");
      if (intent.kind === "restore") {
        this.checkRestore(intent);
        this.opened.get(intent.projectId)?.close();
        this.opened.delete(intent.projectId);
        lock = new OwnerLock(
          lockFilename(this.lockDirectory, "project:" + intent.projectId),
          { pid: process.pid, generation: intent.generation, endpoint: "" },
        );
        this.checkRestore(intent);
      }
      const content = this.prepareBackupStage(intent);
      if (!existsSync(target)) {
        if (intent.kind === "create") {
          if (!existsSync(path.join(content, "backup.json"))) {
            const partial = path.join(content, "project.sqlite");
            if (existsSync(partial)) unlinkSync(partial);
            const project = this.openProject(
                intent.projectId,
              ) as ProjectDatabase,
              state = project.read((tx) => tx.state());
            const args = intent.request.arguments;
            if (
              state.storageGeneration !== args.expectedStorageGeneration ||
              state.revision !== args.expectedRevision ||
              !sameHash(
                state.stateHash,
                args.expectedStateHash as ProjectState["stateHash"],
              )
            )
              throw new RiloomError(
                "REVISION_CONFLICT",
                "工程已变化，请重新创建备份",
              );
            project.db.prepare("VACUUM main INTO ?").run(partial);
            const copy = database(partial, false, 1, true);
            let captured: ProjectState;
            try {
              captured = transaction(copy, false, () =>
                validateStoredProject(copy),
              );
            } finally {
              copy.close();
            }
            writeManifest(content, intent.backupId, intent.createdAt, captured);
          }
          this.backupState(content);
        } else if (intent.kind === "import") {
          if (!existsSync(path.join(content, "backup.json"))) {
            for (const name of ["project.sqlite", "backup.json"]) {
              const partial = path.join(content, name);
              if (existsSync(partial)) unlinkSync(partial);
            }
            copyBackup(intent.source!, content);
          }
          this.backupState(content);
        } else {
          const source = this.prepareRestore(intent.backupId).backup.directory;
          const filename = path.join(content, "project.sqlite");
          if (existsSync(filename)) unlinkSync(filename);
          copyFileSync(path.join(source, "project.sqlite"), filename, 1);
          const db = database(filename, false);
          try {
            transaction(db, true, () => {
              db.prepare(
                "UPDATE meta SET value=? WHERE key='storageGeneration'",
              ).run(canonicalJson(intent.generation));
              db.prepare(
                "INSERT OR REPLACE INTO meta VALUES ('recoveryGeneration',?)",
              ).run(canonicalJson(intent.generation));
              db.prepare(
                "INSERT OR REPLACE INTO meta VALUES ('restoreOperationId',?)",
              ).run(canonicalJson(intent.operationId));
            });
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            db.close();
          }
          flushFile(filename);
          for (const name of ["assets", "artifacts", "staging"])
            mkdirSync(path.join(content, name), { recursive: true });
        }
        this.options.checkpoint?.(
          intent.kind === "restore" ? "restore-copied" : "backup-copied",
        );
        renameSync(content, target);
        flushDirectory(path.dirname(target));
        this.options.checkpoint?.(
          intent.kind === "restore" ? "restore-published" : "backup-published",
        );
      }
      let result: Record<string, unknown>;
      let info: BackupInfo | undefined;
      if (intent.kind === "restore") {
        const transferred = lock;
        lock = undefined;
        restored = new ProjectDatabase(
          target,
          intent.projectId,
          this.lockDirectory,
          this.options.checkpoint,
          transferred,
        );
        const state = restored.read((tx) => tx.state());
        if (
          state.storageGeneration !== intent.generation ||
          restored.db
            .prepare("SELECT value FROM meta WHERE key='restoreOperationId'")
            .get()?.value !== canonicalJson(intent.operationId)
        )
          throw new RiloomError("DATA_CORRUPT", "恢复目录与本次操作不一致");
        result = {
          project: state,
          backupId: intent.backupId,
          directory: intent.directory,
        };
      } else {
        const manifest = this.backupState(target).manifest;
        if (
          intent.sourceHash &&
          !sameHash(intent.sourceHash, hashValue(manifest))
        )
          throw new RiloomError("DATA_CORRUPT", "备份身份与已有内容不一致");
        if (
          manifest.backupId !== intent.backupId ||
          manifest.projectId !== intent.projectId
        )
          throw new RiloomError("DATA_CORRUPT", "备份目录属于另一项操作");
        info = backupInfo(target, manifest);
        result = { backup: info };
      }
      this.clearBackupStage(intent);
      const receipt = transaction(this.db, true, () => {
        if (intent.kind === "restore") {
          const prior = this.registration(intent.projectId);
          if (prior) {
            if (prior.generation !== intent.expectedProject?.storageGeneration)
              throw new RiloomError("REVISION_CONFLICT", "工程登记已变化");
            this.db
              .prepare(
                "UPDATE projects SET directory=?,generation=?,name=?,record_version=record_version+1 WHERE id=?",
              )
              .run(
                intent.directory!,
                intent.generation,
                (result.project as ProjectState).model.name,
                intent.projectId,
              );
          } else {
            if (intent.expectedProject)
              throw new RiloomError("REVISION_CONFLICT", "工程登记已变化");
            this.db
              .prepare(
                "INSERT INTO projects (id,directory,name,generation) VALUES (?,?,?,?)",
              )
              .run(
                intent.projectId,
                intent.directory!,
                (result.project as ProjectState).model.name,
                intent.generation,
              );
          }
          this.advanceCollection("projectsVersion");
        } else {
          const inserted = this.db
            .prepare("INSERT OR IGNORE INTO backups VALUES (?,?,?)")
            .run(intent.backupId, intent.projectId, canonicalJson(info));
          if (inserted.changes) this.advanceCollection("backupsVersion");
        }
        const sequence = Number(
          this.db
            .prepare("INSERT INTO events(operation_id,data) VALUES (?,?)")
            .run(
              intent.operationId,
              canonicalJson({
                projectId: intent.projectId,
                backupId: intent.backupId,
                kind: intent.kind,
              }),
            ).lastInsertRowid,
        );
        const receipt: Receipt = {
          operationId: intent.operationId,
          requestId: intent.request.requestId,
          command: intent.request.command,
          commandVersion: intent.request.commandVersion,
          scope: { workspaceId: this.workspaceId },
          status: "succeeded",
          inputHash: intent.inputHash,
          result,
          artifactRefs: [],
          eventCursor: sequence,
        };
        this.db
          .prepare("INSERT INTO operations VALUES (?,?)")
          .run(receipt.requestId, canonicalJson(receipt));
        this.db
          .prepare("DELETE FROM backup_intents WHERE request_id=?")
          .run(receipt.requestId);
        return receipt;
      });
      if (restored) {
        this.opened.set(intent.projectId, restored);
        restored = undefined;
      }
      this.options.checkpoint?.(
        intent.kind === "restore" ? "restore-registered" : "backup-registered",
      );
      return receipt;
    } catch (error) {
      if (!(error instanceof RiloomError)) throw error;
      this.clearBackupStage(intent);
      return this.backupFailure(intent, error);
    } finally {
      restored?.close();
      lock?.close();
    }
  }

  openProject(projectId: string): ProjectPersistence {
    const existing = this.opened.get(projectId);
    if (existing) return existing;
    const row = this.db
      .prepare("SELECT directory FROM projects WHERE id=?")
      .get(projectId) as { directory: string } | undefined;
    if (!row) throw new RiloomError("NOT_FOUND", "工程未在当前工作区登记");
    const database = new ProjectDatabase(
      this.target(row.directory),
      projectId,
      this.lockDirectory,
      this.options.checkpoint,
    );
    this.opened.set(projectId, database);
    return database;
  }
  projectGeneration(projectId: string): string {
    return this.openProject(projectId).read(
      (tx) => tx.state().storageGeneration,
    );
  }
  close(): void {
    for (const project of this.opened.values()) project.close();
    this.opened.clear();
    this.db.close();
  }
}
