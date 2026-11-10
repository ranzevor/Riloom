import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { RiloomError, type BlobRef } from "@riloom/contracts";

export function digestBytes(data: Uint8Array): BlobRef {
  return {
    hash: {
      algorithm: "sha256",
      digest: createHash("sha256").update(data).digest("hex"),
    },
    bytes: data.byteLength,
  };
}
function assetDirectory(directory: string, create = false): string {
  const target = path.join(directory, "assets");
  if (!existsSync(target)) {
    if (!create) throw new RiloomError("DATA_CORRUPT", "工程素材目录缺失");
    mkdirSync(target);
  }
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RiloomError("PERMISSION_DENIED", "素材目录必须位于工程内");
  return target;
}
function filename(directory: string, reference: BlobRef): string {
  if (
    reference.hash.algorithm !== "sha256" ||
    !/^[a-f0-9]{64}$/.test(reference.hash.digest) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 1 ||
    reference.bytes > 67108864
  )
    throw new RiloomError("DATA_CORRUPT", "素材引用无效");
  return path.join(assetDirectory(directory), reference.hash.digest);
}
export function readBlobFile(directory: string, reference: BlobRef): Buffer {
  const file = filename(directory, reference);
  if (!existsSync(file)) throw new RiloomError("DATA_CORRUPT", "工程素材缺失");
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== reference.bytes)
    throw new RiloomError("DATA_CORRUPT", "工程素材长度或类型无效");
  const data = readFileSync(file);
  if (digestBytes(data).hash.digest !== reference.hash.digest)
    throw new RiloomError("DATA_CORRUPT", "工程素材内容损坏");
  return data;
}
function flushDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
export function writeBlobFile(directory: string, data: Uint8Array): BlobRef {
  assetDirectory(directory, true);
  const reference = digestBytes(data),
    file = filename(directory, reference);
  if (existsSync(file)) {
    readBlobFile(directory, reference);
    return reference;
  }
  const temporary = path.join(
    assetDirectory(directory),
    ".write-" + randomUUID(),
  );
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const descriptor = openSync(temporary, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    readBlobFile(directory, reference);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  flushDirectory(assetDirectory(directory));
  return reference;
}
export function copyBlobFiles(
  source: string,
  target: string,
  references: BlobRef[],
): void {
  assetDirectory(target, true);
  for (const reference of references) {
    readBlobFile(source, reference);
    const destination = filename(target, reference);
    if (existsSync(destination)) readBlobFile(target, reference);
    else {
      copyFileSync(filename(source, reference), destination, 1);
      const descriptor = openSync(destination, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      readBlobFile(target, reference);
    }
  }
  flushDirectory(assetDirectory(target));
}
export function checkBlobFiles(directory: string, references: BlobRef[]): void {
  const expected = [
    ...new Set(references.map((reference) => reference.hash.digest)),
  ].sort();
  const target = path.join(directory, "assets");
  const actual = existsSync(target)
    ? readdirSync(assetDirectory(directory)).sort()
    : [];
  if (actual.join(",") !== expected.join(","))
    throw new RiloomError("DATA_CORRUPT", "备份素材集合与清单不一致");
  for (const reference of references) readBlobFile(directory, reference);
}
