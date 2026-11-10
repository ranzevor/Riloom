import type { FromSchema } from "json-schema-to-ts";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type StateHash = { algorithm: "sha256"; digest: string };
export const version = "1.0.0";
const id = {
  type: "string",
  minLength: 1,
  maxLength: 96,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
} as const;
const hash = {
  type: "object",
  additionalProperties: false,
  required: ["algorithm", "digest"],
  properties: {
    algorithm: { const: "sha256" },
    digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
} as const;
export const parameterSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "unit", "min", "default", "max", "value"],
  properties: {
    id,
    name: { type: "string", minLength: 1, maxLength: 120 },
    unit: { type: "string", maxLength: 32 },
    min: { type: "number" },
    default: { type: "number" },
    max: { type: "number" },
    value: { type: "number" },
  },
} as const;
export type Parameter = FromSchema<typeof parameterSchema>;
export const blobSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hash", "bytes"],
  properties: {
    hash,
    bytes: { type: "integer", minimum: 1, maximum: 67108864 },
  },
} as const;
export type BlobRef = FromSchema<typeof blobSchema>;
export const assetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "width",
    "height",
    "bitDepth",
    "source",
    "pixels",
    "colorSpace",
    "colorSource",
  ],
  properties: {
    id,
    name: { type: "string", minLength: 1, maxLength: 120 },
    width: { type: "integer", minimum: 1, maximum: 32768 },
    height: { type: "integer", minimum: 1, maximum: 32768 },
    bitDepth: { enum: [8, 16] },
    source: blobSchema,
    pixels: blobSchema,
    colorSpace: { const: "srgb" },
    colorSource: { enum: ["assumed-srgb", "srgb-chunk"] },
  },
} as const;
export type Asset = FromSchema<typeof assetSchema>;
export const drawItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "assetId",
    "x",
    "y",
    "visible",
    "opacity",
    "drawOrder",
    "orderToken",
  ],
  properties: {
    id,
    name: { type: "string", minLength: 1, maxLength: 120 },
    assetId: id,
    x: { type: "number" },
    y: { type: "number" },
    visible: { type: "boolean" },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    drawOrder: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
    orderToken: id,
  },
} as const;
export type DrawItem = FromSchema<typeof drawItemSchema>;
const addChange = <T extends string, S>(type: T, schema: S) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["type", "after"],
    properties: {
      type: { const: type },
      after: schema,
      index: { type: "integer", minimum: 0 },
    },
  }) as const;
const removeChange = <T extends string, S>(type: T, schema: S) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["type", "before"],
    properties: { type: { const: type }, before: schema },
  }) as const;
const updateChange = <T extends string, S>(type: T, schema: S) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["type", "before", "after"],
    properties: { type: { const: type }, before: schema, after: schema },
  }) as const;
export const changeSchema = {
  oneOf: [
    addChange("addParameter", parameterSchema),
    removeChange("removeParameter", parameterSchema),
    updateChange("updateParameter", parameterSchema),
    addChange("addAsset", assetSchema),
    removeChange("removeAsset", assetSchema),
    addChange("addDrawItem", drawItemSchema),
    removeChange("removeDrawItem", drawItemSchema),
    updateChange("updateDrawItem", drawItemSchema),
    updateChange("setFormat", { enum: ["1.0.0", "1.1.0"] } as const),
  ],
} as const;
export type Change = FromSchema<typeof changeSchema>;
export type Canvas = { width: number; height: number };
export interface ProjectModel {
  projectId: string;
  formatVersion: "1.0.0" | "1.1.0";
  name: string;
  canvas: Canvas;
  parameters: Parameter[];
  assets?: Asset[];
  drawItems?: DrawItem[];
}
export interface ProjectState {
  model: ProjectModel;
  revision: number;
  stateHash: StateHash;
  storageGeneration: string;
  eventCursor: number;
  historyVersion: number;
  undoGroupId: string | null;
  redoGroupId: string | null;
}
export interface Draft {
  projectId: string;
  draftId: string;
  editorId: string;
  baseRevision: number;
  baseStateHash: StateHash;
  draftVersion: number;
  editGeneration: number;
  draftStatus: "editing" | "applied" | "discarded";
  changes: Change[];
  inverseChanges: Change[];
}
export interface Candidate {
  candidateId: string;
  draftId: string;
  draftVersion: number;
  sourceRevision: number;
  sourceStateHash: StateHash;
  changes: Change[];
  inverseChanges: Change[];
  status: "ready" | "applied";
}
export type ErrorCode =
  | "INVALID_INPUT"
  | "PERMISSION_DENIED"
  | "REVISION_CONFLICT"
  | "CURSOR_INVALIDATED"
  | "REQUEST_ID_REUSED"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_FEATURE"
  | "RESOURCE_BUSY"
  | "DATA_CORRUPT"
  | "NOT_FOUND"
  | "EFFECT_UNRESOLVED"
  | "INTERNAL_ERROR";
export class RiloomError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, Json> = {},
  ) {
    super(message);
    this.name = "RiloomError";
  }
}
export interface CommandRequest {
  requestId: string;
  command: string;
  commandVersion: string;
  workspaceId?: string;
  projectId?: string;
  expectedRevision?: number;
  expectedStateHash?: StateHash;
  expectedDraftVersion?: number;
  expectedHistoryVersion?: number;
  expectedStorageGeneration?: string;
  arguments: Record<string, unknown>;
}
export interface Scope {
  workspaceId: string;
  projectId?: string;
}
export interface Receipt {
  operationId: string;
  requestId: string;
  command: string;
  commandVersion: string;
  scope: Scope;
  status: "succeeded" | "failed";
  inputHash: StateHash;
  result: Record<string, unknown>;
  artifactRefs: never[];
  eventCursor: number;
  beforeRevision?: number;
  afterRevision?: number;
  stateHash?: StateHash;
  error?: { code: ErrorCode; message: string; details: Record<string, Json> };
}
export interface RegisteredProject {
  projectId: string;
  name: string;
  directory: string;
  storageGeneration: string;
  recordVersion: number;
}
export interface BackupInfo {
  backupId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  revision: number;
  stateHash: StateHash;
  bytes: number;
  directory: string;
  recordVersion: number;
}
export interface RestoreExpectation {
  storageGeneration: string;
  revision?: number;
  stateHash?: StateHash;
}
export interface RestorePlan {
  backup: BackupInfo;
  currentStatus: "registered" | "damaged" | "unregistered";
  expectedProject?: RestoreExpectation;
}
export interface ProjectEvent {
  projectId: string;
  sequence: number;
  type: string;
  operationId: string;
  revision: number;
  data: Record<string, unknown>;
}
export interface Session {
  sessionId: string;
  workspaceId: string;
  serviceGeneration: string;
  expiresAt: number;
  allowedCommands: string[];
  projectGenerations: Record<string, string>;
}

const object = <T extends Record<string, unknown>>(
  properties: T,
  required: string[] = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const integer = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const listArguments = object(
  {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string", maxLength: 4096 },
  },
  [],
);
const changes = {
  type: "array",
  minItems: 0,
  maxItems: 256,
  items: changeSchema,
};
export const commands = {
  "riloom.asset.import": {
    scope: "project",
    kind: "prepare",
    description: "导入 PNG 素材并准备绘画草稿",
    schema: object(
      {
        name: { type: "string", minLength: 1, maxLength: 120 },
        pngBase64: { type: "string", minLength: 12, maxLength: 22369624 },
        draftId: id,
        editorId: id,
        baseRevision: integer,
        baseStateHash: hash,
      },
      ["name", "pngBase64"],
    ),
  },
  "riloom.asset.read": {
    scope: "project",
    kind: "query",
    description: "读取工程素材内容",
    schema: object(
      {
        blob: blobSchema,
        offset: integer,
        length: { type: "integer", minimum: 1, maximum: 4194304 },
      },
      ["blob"],
    ),
  },
  "riloom.workspace.get": {
    scope: "workspace",
    kind: "query",
    description: "读取工作区与可用命令",
    schema: object({}),
  },
  "riloom.project.list": {
    scope: "workspace",
    kind: "query",
    description: "列出已登记工程",
    schema: listArguments,
  },
  "riloom.project.create": {
    scope: "workspace",
    kind: "prepare",
    description: "创建空工程",
    schema: object({
      name: { type: "string", minLength: 1, maxLength: 120 },
      directory: { type: "string", minLength: 1, maxLength: 120 },
      canvas: object({
        width: { type: "integer", minimum: 1, maximum: 32768 },
        height: { type: "integer", minimum: 1, maximum: 32768 },
      }),
    }),
  },
  "riloom.project.open": {
    scope: "workspace",
    kind: "query",
    description: "打开工程并刷新当前存储授权",
    schema: object({ projectId: id }),
  },
  "riloom.project.backup": {
    scope: "workspace",
    kind: "maintenance",
    description: "保存工程的一致性备份",
    schema: object({
      projectId: id,
      expectedStorageGeneration: id,
      expectedRevision: integer,
      expectedStateHash: hash,
    }),
  },
  "riloom.project.listBackups": {
    scope: "workspace",
    kind: "query",
    description: "列出工作区中的工程备份",
    schema: object({ ...listArguments.properties, projectId: id }, []),
  },
  "riloom.project.importBackup": {
    scope: "workspace",
    kind: "maintenance",
    description: "导入本地备份目录",
    schema: object({
      directory: { type: "string", minLength: 1, maxLength: 4096 },
    }),
  },
  "riloom.project.prepareRestore": {
    scope: "workspace",
    kind: "query",
    description: "读取备份及当前恢复前提",
    schema: object({ backupId: id }),
  },
  "riloom.project.restore": {
    scope: "workspace",
    kind: "maintenance",
    description: "从备份恢复工程并接替登记",
    schema: object(
      {
        backupId: id,
        directory: { type: "string", minLength: 1, maxLength: 120 },
        expectedProject: object(
          { storageGeneration: id, revision: integer, stateHash: hash },
          ["storageGeneration"],
        ),
      },
      ["backupId", "directory"],
    ),
  },
  "riloom.project.get": {
    scope: "project",
    kind: "query",
    description: "读取工程与当前修订",
    schema: object({}),
  },
  "riloom.project.getOperation": {
    scope: "project",
    kind: "query",
    description: "按原请求查询回执",
    schema: object({ requestId: id }),
  },
  "riloom.workspace.getOperation": {
    scope: "workspace",
    kind: "query",
    description: "查询工作区请求回执",
    schema: object({ requestId: id }),
  },
  "riloom.project.listDrafts": {
    scope: "project",
    kind: "query",
    description: "读取保存的草稿",
    schema: listArguments,
  },
  "riloom.project.getDraft": {
    scope: "project",
    kind: "query",
    description: "读取指定草稿",
    schema: object({ draftId: id }),
  },
  "riloom.project.saveDraft": {
    scope: "project",
    kind: "prepare",
    description: "保存完整草稿",
    schema: object({
      draftId: id,
      editorId: id,
      baseRevision: integer,
      baseStateHash: hash,
      editGeneration: { ...integer, minimum: 1 },
      changes,
    }),
  },
  "riloom.project.discardDraft": {
    scope: "project",
    kind: "maintenance",
    description: "丢弃指定版本的草稿",
    schema: object({ draftId: id }),
  },
  "riloom.project.prepareDraft": {
    scope: "project",
    kind: "prepare",
    description: "准备已保存草稿的应用候选",
    schema: object({ draftId: id }),
  },
  "riloom.project.apply": {
    scope: "project",
    kind: "apply",
    description: "原子应用草稿候选",
    schema: object({ candidateId: id, draftId: id }),
  },
  "riloom.project.undo": {
    scope: "project",
    kind: "apply",
    description: "撤销指定历史组",
    schema: object({ undoGroupId: id }),
  },
  "riloom.project.redo": {
    scope: "project",
    kind: "apply",
    description: "重做指定历史组",
    schema: object({ undoGroupId: id }),
  },
} as const;
export type CommandName = keyof typeof commands;
export const requestSchema = (command: CommandName) => {
  const spec = commands[command];
  const required = [
    "requestId",
    "command",
    "commandVersion",
    "arguments",
    spec.scope === "workspace" ? "workspaceId" : "projectId",
  ];
  if (
    [
      "riloom.project.saveDraft",
      "riloom.asset.import",
      "riloom.project.discardDraft",
      "riloom.project.prepareDraft",
      "riloom.project.apply",
    ].includes(command)
  )
    required.push("expectedDraftVersion");
  if (spec.kind === "apply")
    required.push("expectedRevision", "expectedStateHash");
  if (command === "riloom.project.undo" || command === "riloom.project.redo")
    required.push("expectedHistoryVersion");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      requestId: id,
      command: { const: command },
      commandVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
      workspaceId: id,
      projectId: id,
      expectedRevision: integer,
      expectedStateHash: hash,
      expectedDraftVersion: integer,
      expectedHistoryVersion: integer,
      expectedStorageGeneration: id,
      arguments: spec.schema,
    },
  };
};
