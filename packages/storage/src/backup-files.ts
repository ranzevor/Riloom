import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  RiloomError,
  type BackupInfo,
  type StateHash,
  type ProjectState,
} from "@riloom/contracts";
import { canonicalJson } from "@riloom/core";

export interface BackupManifest {
  format: "riloom.backup/1";
  backupId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  revision: number;
  stateHash: StateHash;
  database: { bytes: number; hash: StateHash };
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
function validHash(value: unknown): value is StateHash {
  if (!value || typeof value !== "object") return false;
  const hash = value as StateHash;
  return (
    hash.algorithm === "sha256" &&
    typeof hash.digest === "string" &&
    /^[a-f0-9]{64}$/.test(hash.digest)
  );
}
function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object")
    throw new RiloomError("DATA_CORRUPT", "备份清单无效");
  const manifest = value as BackupManifest;
  if (manifest.format !== "riloom.backup/1")
    throw new RiloomError("UNSUPPORTED_VERSION", "备份格式版本不受支持");
  const keys = [
    "format",
    "backupId",
    "projectId",
    "projectName",
    "createdAt",
    "revision",
    "stateHash",
    "database",
  ];
  if (
    Object.keys(manifest).some((key) => !keys.includes(key)) ||
    typeof manifest.backupId !== "string" ||
    !idPattern.test(manifest.backupId) ||
    typeof manifest.projectId !== "string" ||
    !idPattern.test(manifest.projectId) ||
    typeof manifest.projectName !== "string" ||
    !manifest.projectName.trim() ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !validHash(manifest.stateHash) ||
    !manifest.database ||
    Object.keys(manifest.database).sort().join(",") !== "bytes,hash" ||
    !Number.isSafeInteger(manifest.database.bytes) ||
    manifest.database.bytes < 1 ||
    !validHash(manifest.database.hash)
  ) {
    throw new RiloomError("DATA_CORRUPT", "备份清单字段无效");
  }
  return manifest;
}
export function regularFile(filename: string): void {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new RiloomError("PERMISSION_DENIED", "备份文件必须为常规文件");
}
export function hashFile(filename: string): StateHash {
  regularFile(filename);
  const descriptor = openSync(filename, "r"),
    buffer = Buffer.alloc(65536),
    digest = createHash("sha256");
  try {
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0)
      digest.update(buffer.subarray(0, count));
  } finally {
    closeSync(descriptor);
  }
  return { algorithm: "sha256", digest: digest.digest("hex") };
}
export function flush(filename: string): void {
  const descriptor = openSync(filename, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
export function readBackup(directory: string): BackupManifest {
  if (!existsSync(directory))
    throw new RiloomError("NOT_FOUND", "备份目录不存在");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new RiloomError("PERMISSION_DENIED", "备份目录不能为链接");
  const members = readdirSync(directory).sort();
  if (members.join(",") !== "backup.json,project.sqlite")
    throw new RiloomError("DATA_CORRUPT", "备份文件集合不完整");
  const filename = path.join(directory, "backup.json");
  regularFile(filename);
  if (lstatSync(filename).size > 65536)
    throw new RiloomError("DATA_CORRUPT", "备份清单过大");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(filename)),
    );
  } catch {
    throw new RiloomError("DATA_CORRUPT", "备份清单无法读取");
  }
  const manifest = validateManifest(parsed),
    database = path.join(directory, "project.sqlite");
  regularFile(database);
  if (
    lstatSync(database).size !== manifest.database.bytes ||
    hashFile(database).digest !== manifest.database.hash.digest
  ) {
    throw new RiloomError("DATA_CORRUPT", "备份数据库与清单不一致");
  }
  return manifest;
}
export function writeManifest(
  directory: string,
  backupId: string,
  createdAt: string,
  state: ProjectState,
): BackupManifest {
  const filename = path.join(directory, "project.sqlite");
  flush(filename);
  const manifest: BackupManifest = {
    format: "riloom.backup/1",
    backupId,
    projectId: state.model.projectId,
    projectName: state.model.name,
    createdAt,
    revision: state.revision,
    stateHash: state.stateHash,
    database: { bytes: lstatSync(filename).size, hash: hashFile(filename) },
  };
  writeFileSync(
    path.join(directory, "backup.json"),
    canonicalJson(manifest) + "\n",
    { flag: "wx" },
  );
  flush(path.join(directory, "backup.json"));
  return manifest;
}
export function backupInfo(
  directory: string,
  manifest: BackupManifest,
): BackupInfo {
  return {
    backupId: manifest.backupId,
    projectId: manifest.projectId,
    projectName: manifest.projectName,
    createdAt: manifest.createdAt,
    revision: manifest.revision,
    stateHash: manifest.stateHash,
    bytes: manifest.database.bytes,
    directory: realpathSync(directory),
    recordVersion: 1,
  };
}
export function copyBackup(source: string, target: string): BackupManifest {
  const manifest = readBackup(source);
  copyFileSync(
    path.join(source, "project.sqlite"),
    path.join(target, "project.sqlite"),
    1,
  );
  copyFileSync(
    path.join(source, "backup.json"),
    path.join(target, "backup.json"),
    1,
  );
  flush(path.join(target, "project.sqlite"));
  flush(path.join(target, "backup.json"));
  const copied = readBackup(target);
  if (canonicalJson(manifest) !== canonicalJson(copied))
    throw new RiloomError("DATA_CORRUPT", "备份在复制期间发生变化");
  return copied;
}
