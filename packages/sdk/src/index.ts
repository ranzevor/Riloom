import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { FramedConnection, OwnerLock, connectPipe } from "@riloom/platform";
import {
  RiloomError,
  type CommandRequest,
  type ErrorCode,
  type Json,
  type Receipt,
} from "@riloom/contracts";

export class RiloomClient {
  private session = "";
  workspaceId = "";
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(private readonly connection: FramedConnection) {
    connection.on("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new RiloomError("EFFECT_UNRESOLVED", "连接已中断，请查询原请求回执"),
        );
      }
      this.pending.clear();
    });
    connection.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as {
        kind?: string;
        id?: string;
        ok?: boolean;
        value?: unknown;
        error?: {
          code: ErrorCode;
          message: string;
          details: Record<string, Json>;
        };
      };
      if (message.kind !== "response" || !message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else
        pending.reject(
          new RiloomError(
            message.error?.code ?? "INTERNAL_ERROR",
            message.error?.message ?? "操作失败",
            message.error?.details ?? {},
          ),
        );
    });
  }
  static async connect(workspace: string): Promise<RiloomClient> {
    const root = realpathSync(workspace),
      owner = OwnerLock.read(path.join(root, ".riloom", "owner.sqlite"));
    if (!owner) throw new RiloomError("RESOURCE_BUSY", "工作区服务没有运行");
    const wire = await connectPipe(owner.endpoint);
    if (wire.peerPid !== owner.pid) {
      wire.close();
      throw new RiloomError("PERMISSION_DENIED", "端点与工作区所有者不一致");
    }
    const connection = new FramedConnection(wire),
      client = new RiloomClient(connection);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.close();
          reject(new RiloomError("PERMISSION_DENIED", "本地握手超时"));
        }, 10000);
        const close = () => {
          clearTimeout(timer);
          reject(new RiloomError("PERMISSION_DENIED", "本地握手失败"));
        };
        connection.once("close", close);
        const message = (value: {
          kind?: string;
          nonce?: string;
          session?: string;
          workspaceId?: string;
          generation?: string;
        }) => {
          if (value.kind === "challenge" && typeof value.nonce === "string")
            void connection
              .send({ kind: "authorize", nonce: value.nonce })
              .catch(reject);
          if (
            value.kind === "ready" &&
            typeof value.session === "string" &&
            typeof value.workspaceId === "string" &&
            value.generation === owner.generation
          ) {
            client.session = value.session;
            client.workspaceId = value.workspaceId;
            clearTimeout(timer);
            connection.off("close", close);
            connection.off("message", message);
            resolve();
          }
        };
        connection.on("message", message);
        void connection
          .send({
            kind: "hello",
            protocol: "riloom.ipc/1",
            workspace: root,
            generation: owner.generation,
            clientId: randomUUID(),
          })
          .catch(reject);
      });
      return client;
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  async execute(request: CommandRequest): Promise<Receipt> {
    return this.request("command", request) as Promise<Receipt>;
  }
  async browserLink(): Promise<string> {
    const result = (await this.request("browser")) as { url: string };
    return result.url;
  }
  async shutdown(): Promise<void> {
    await this.request("shutdown");
  }
  close(): void {
    this.connection.close();
  }
  private async request(method: string, body?: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RiloomError("EFFECT_UNRESOLVED", "请求超时，请查询原请求回执"),
        );
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      void this.connection
        .send({
          kind: "request",
          id,
          session: this.session,
          method,
          ...(body === undefined ? {} : { body }),
        })
        .catch((error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
    });
  }
}
