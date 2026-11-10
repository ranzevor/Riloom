import { DatabaseSync } from "node:sqlite";
import {
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
} from "@riloom/application";
import {
  OwnerLock,
  identityLockDirectory,
  lockFilename,
  privateDirectory,
} from "@riloom/platform";

const applicationId = 0x52494c4d;
function parse<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new RiloomError("DATA_CORRUPT", "工程记录无法读取");
  }
}
function database(filename: string, initialize: boolean): DatabaseSync {
  if (!initialize && !existsSync(filename))
    throw new RiloomError("DATA_CORRUPT", "工程数据库缺失");
  if (
    existsSync(filename) &&
    (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
  )
    throw new RiloomError("PERMISSION_DENIED", "数据库必须为工程内的常规文件");
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      "PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    const id = Number(
      (db.prepare("PRAGMA application_id").get() as { application_id: number })
        .application_id,
    );
    if (initialize && id === 0)
      db.exec(
        "PRAGMA application_id=" + applicationId + "; PRAGMA user_version=1;",
      );
    else if (
      id !== applicationId ||
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version !== 1
    )
      throw new RiloomError("DATA_CORRUPT", "文件不是受支持的 Riloom 数据库");
    const check = db.prepare("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    if (check.quick_check !== "ok")
      throw new RiloomError("DATA_CORRUPT", "数据库完整性检查失败");
    return db;
  } catch (error) {
    db.close();
    throw error;
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
    return {
      model,
      revision: this.get("revision"),
      stateHash,
      storageGeneration: this.get("storageGeneration"),
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
class ProjectDatabase implements ProjectPersistence {
  readonly db: DatabaseSync;
  readonly lock: OwnerLock;
  constructor(
    directory: string,
    projectId: string,
    lockDirectory: string,
    private readonly checkpoint?: StorageOptions["checkpoint"],
  ) {
    if (lstatSync(directory).isSymbolicLink())
      throw new RiloomError("PERMISSION_DENIED", "工程目录不能为符号链接");
    this.lock = new OwnerLock(
      lockFilename(lockDirectory, "project:" + projectId),
      { pid: process.pid, generation: randomUUID(), endpoint: "" },
    );
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
export interface StorageOptions {
  lockDirectory?: string;
  checkpoint?: (
    point:
      | "create-intent"
      | "project-ready"
      | "project-published"
      | "before-project-commit",
  ) => void;
}
export class SQLiteWorkspace implements WorkspacePersistence {
  readonly workspaceId: string;
  private readonly db: DatabaseSync;
  private readonly opened = new Map<string, ProjectDatabase>();
  private readonly lockDirectory: string;
  private readonly staging: string;
  readonly root: string;
  constructor(
    directory: string,
    private readonly options: StorageOptions = {},
  ) {
    mkdirSync(directory, { recursive: true });
    this.root = realpathSync(directory);
    const internal = privateDirectory(path.join(this.root, ".riloom"));
    this.staging = privateDirectory(path.join(internal, "staging"));
    this.lockDirectory = options.lockDirectory
      ? privateDirectory(options.lockDirectory)
      : identityLockDirectory();
    const filename = path.join(this.root, "workspace.sqlite"),
      fresh = !existsSync(filename);
    this.db = database(filename, fresh);
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
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key='workspaceId'")
        .get() as { value: string } | undefined;
      if (!row) throw new RiloomError("DATA_CORRUPT", "工作区身份记录缺失");
      this.workspaceId = row.value;
      for (const pending of this.db
        .prepare("SELECT data FROM intents")
        .all() as { data: string }[])
        this.finish(parse<Intent>(pending.data), true);
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
            .prepare("SELECT COALESCE(MAX(sequence),0) AS seq FROM events")
            .get() as { seq: number }
        ).seq,
      ),
      items: (
        this.db.prepare("SELECT * FROM projects ORDER BY id").all() as {
          id: string;
          directory: string;
          name: string;
          generation: string;
        }[]
      ).map((row) => ({
        projectId: row.id,
        directory: row.directory,
        name: row.name,
        storageGeneration: row.generation,
        recordVersion: 1,
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
  private removeStage(intent: Intent): void {
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
          .prepare("INSERT INTO projects VALUES (?,?,?,?)")
          .run(
            state.model.projectId,
            intent.directory,
            state.model.name,
            state.storageGeneration,
          );
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
