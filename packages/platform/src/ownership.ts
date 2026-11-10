import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { RiloomError } from "@riloom/contracts";
import { protectPrivatePath } from "./pipes.js";

export interface Owner {
  pid: number;
  generation: string;
  endpoint: string;
}
export function privateDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new RiloomError("PERMISSION_DENIED", "内部目录不能为符号链接");
  protectPrivatePath(directory);
  return realpathSync(directory);
}
export function identityLockDirectory(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? os.homedir())
      : (process.env.XDG_STATE_HOME ??
        path.join(os.homedir(), ".local", "state"));
  return privateDirectory(path.join(base, "Riloom", "locks"));
}
export function lockFilename(directory: string, identity: string): string {
  return path.join(
    directory,
    createHash("sha256").update(identity).digest("hex") + ".sqlite",
  );
}
function busy(error: unknown): boolean {
  return error instanceof Error && /locked|busy/i.test(error.message);
}
export class OwnerLock {
  private readonly db: DatabaseSync;
  constructor(
    public readonly filename: string,
    owner: Owner,
  ) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL)",
      );
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare("INSERT OR REPLACE INTO owner VALUES (1, ?)")
        .run(JSON.stringify(owner));
      this.db.exec("COMMIT; BEGIN IMMEDIATE");
      const row = this.db
        .prepare("SELECT data FROM owner WHERE singleton=1")
        .get() as { data: string };
      if (row.data !== JSON.stringify(owner))
        throw new RiloomError("RESOURCE_BUSY", "工作区正由另一服务持有");
    } catch (error) {
      this.db.close();
      if (busy(error))
        throw new RiloomError("RESOURCE_BUSY", "工作区或工程正由另一服务使用");
      throw error;
    }
  }
  close(): void {
    this.db.exec("ROLLBACK");
    this.db.close();
  }
  static read(filename: string): Owner | null {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(filename, { open: true });
      db.exec("PRAGMA busy_timeout=0");
      const row = db
        .prepare("SELECT data FROM owner WHERE singleton=1")
        .get() as { data: string } | undefined;
      if (!row) return null;
      try {
        db.exec("BEGIN IMMEDIATE; ROLLBACK");
        return null;
      } catch (error) {
        if (!busy(error)) throw error;
      }
      const owner = JSON.parse(row.data) as Owner;
      return Number.isSafeInteger(owner.pid) &&
        typeof owner.generation === "string" &&
        typeof owner.endpoint === "string"
        ? owner
        : null;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}
