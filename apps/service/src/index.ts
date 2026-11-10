import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "@riloom/application";
import {
  commands,
  RiloomError,
  validateRequest,
  type Session,
} from "@riloom/contracts";
import {
  FramedConnection,
  listenPipe,
  OwnerLock,
  privateDirectory,
  type Wire,
} from "@riloom/platform";
import { SQLiteWorkspace, type StorageOptions } from "@riloom/storage";

export const serviceEntryPoint = fileURLToPath(
  new URL("./main.js", import.meta.url),
);
export interface ServiceOptions {
  workspace: string;
  port?: number;
  storage?: StorageOptions;
}
export interface RunningService {
  workspaceId: string;
  generation: string;
  url: string;
  endpoint: string;
  close(): Promise<void>;
}
interface Grant extends Session {
  token: string;
  csrf: string;
}
const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function failure(error: unknown) {
  return error instanceof RiloomError
    ? { code: error.code, message: error.message, details: error.details }
    : {
        code: "INTERNAL_ERROR",
        message: "操作失败，请查询原请求后重试",
        details: {},
      };
}

export async function startService(
  options: ServiceOptions,
): Promise<RunningService> {
  mkdirSync(options.workspace, { recursive: true });
  const root = realpathSync(options.workspace),
    internal = privateDirectory(path.join(root, ".riloom"));
  const socketDirectory =
    process.platform === "win32"
      ? undefined
      : privateDirectory(mkdtempSync(path.join(os.tmpdir(), "rl-")));
  const generation = randomUUID(),
    endpoint =
      process.platform === "win32"
        ? "\\\\.\\pipe\\riloom-" + generation
        : path.join(socketDirectory!, "service.sock");
  let ownership: OwnerLock;
  try {
    ownership = new OwnerLock(path.join(internal, "owner.sqlite"), {
      pid: process.pid,
      generation,
      endpoint,
    });
  } catch (error) {
    if (socketDirectory) rmdirSync(socketDirectory);
    throw error;
  }
  let workspace: SQLiteWorkspace;
  try {
    workspace = new SQLiteWorkspace(root, options.storage);
  } catch (error) {
    ownership.close();
    if (socketDirectory) rmdirSync(socketDirectory);
    throw error;
  }
  const application = new Application(workspace, generation, secret());
  const wires = new Set<FramedConnection>(),
    grants = new Map<string, Grant>(),
    tickets = new Map<string, { expiry: number }>();
  const eventTimers = new Set<ReturnType<typeof setInterval>>();
  let origin = "",
    stopping = false;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const pruneAuth = () => {
    const now = Date.now();
    for (const [token, grant] of grants)
      if (grant.expiresAt <= now) grants.delete(token);
    for (const [token, ticket] of tickets)
      if (ticket.expiry <= now) tickets.delete(token);
  };
  const createGrant = (): Grant => {
    pruneAuth();
    if (grants.size >= 128)
      throw new RiloomError("RESOURCE_BUSY", "工作区会话数量已达上限");
    const grant: Grant = {
      token: secret(),
      csrf: secret(),
      sessionId: randomUUID(),
      workspaceId: workspace.workspaceId,
      serviceGeneration: generation,
      expiresAt: Date.now() + 3600000,
      allowedCommands: Object.keys(commands),
      projectGenerations: {},
    };
    grants.set(grant.token, grant);
    return grant;
  };
  const validGrant = (token: string | undefined): Grant => {
    const grant = token ? grants.get(token) : undefined;
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.serviceGeneration !== generation ||
      stopping
    )
      throw new RiloomError(
        "PERMISSION_DENIED",
        "会话已失效，请重新连接工作区",
      );
    return grant;
  };
  const checkProject = (grant: Grant, projectId: string): void => {
    const current = workspace.projectGeneration(projectId);
    const previous = grant.projectGenerations[projectId];
    if (previous && previous !== current)
      throw new RiloomError("PERMISSION_DENIED", "工程存储已变化，请重新连接");
    grant.projectGenerations[projectId] = current;
  };
  const execute = (grant: Grant, value: unknown) => {
    validGrant(grant.token);
    const request = validateRequest(value);
    if (!grant.allowedCommands.includes(request.command))
      throw new RiloomError("PERMISSION_DENIED", "会话未授权此操作");
    if (request.projectId) checkProject(grant, request.projectId);
    if (request.command === "riloom.project.backup")
      checkProject(grant, request.arguments.projectId as string);
    const receipt = application.execute(request);
    if (
      request.command === "riloom.project.open" &&
      receipt.status === "succeeded"
    ) {
      const project = receipt.result
        .project as import("@riloom/contracts").ProjectState;
      grant.projectGenerations[project.model.projectId] =
        project.storageGeneration;
    }
    return receipt;
  };
  const browserLink = () => {
    pruneAuth();
    if (tickets.size >= 64)
      throw new RiloomError("RESOURCE_BUSY", "待使用的启动链接数量已达上限");
    const token = secret();
    tickets.set(token, { expiry: Date.now() + 60000 });
    return origin + "/#" + token;
  };
  let pipe: Awaited<ReturnType<typeof listenPipe>>;
  try {
    pipe = await listenPipe(endpoint, (wire: Wire) => {
      if (wires.size >= 16) {
        wire.close();
        return;
      }
      const framed = new FramedConnection(wire);
      wires.add(framed);
      let challenge: string | undefined, grant: Grant | undefined;
      const handshakeTimer = setTimeout(() => framed.close(), 10000);
      framed.on("close", () => {
        clearTimeout(handshakeTimer);
        wires.delete(framed);
        if (grant) grants.delete(grant.token);
      });
      framed.on("message", (message: unknown) => {
        const handle = async () => {
          await ready;
          if (stopping) return;
          if (!message || typeof message !== "object") {
            framed.close();
            return;
          }
          const input = message as Record<string, unknown>;
          if (input.kind === "hello" && !challenge && !grant) {
            if (
              input.protocol !== "riloom.ipc/1" ||
              input.workspace !== root ||
              input.generation !== generation ||
              typeof input.clientId !== "string"
            ) {
              framed.close();
              return;
            }
            challenge = secret();
            await framed.send({ kind: "challenge", nonce: challenge });
            return;
          }
          if (input.kind === "authorize" && challenge && !grant) {
            if (input.nonce !== challenge) {
              framed.close();
              return;
            }
            challenge = undefined;
            grant = createGrant();
            clearTimeout(handshakeTimer);
            await framed.send({
              kind: "ready",
              session: grant.token,
              workspaceId: workspace.workspaceId,
              generation,
            });
            return;
          }
          if (
            input.kind !== "request" ||
            typeof input.id !== "string" ||
            !grant ||
            typeof input.session !== "string" ||
            !equal(input.session, grant.token)
          ) {
            framed.close();
            return;
          }
          try {
            validGrant(grant.token);
            if (input.method === "command")
              await framed.send({
                kind: "response",
                id: input.id,
                ok: true,
                value: execute(grant, input.body),
              });
            else if (input.method === "browser")
              await framed.send({
                kind: "response",
                id: input.id,
                ok: true,
                value: { url: browserLink() },
              });
            else if (input.method === "shutdown") {
              await framed.send({
                kind: "response",
                id: input.id,
                ok: true,
                value: { stopping: true },
              });
              setImmediate(() => void close());
            } else throw new RiloomError("INVALID_INPUT", "本地请求方法无效");
          } catch (error) {
            await framed.send({
              kind: "response",
              id: input.id,
              ok: false,
              error: failure(error),
            });
          }
        };
        void handle().catch(() => framed.close());
      });
    });
  } catch (error) {
    workspace.close();
    ownership.close();
    if (socketDirectory) rmdirSync(socketDirectory);
    throw error;
  }
  const server = http.createServer((request, response) => {
    void handleHttp(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const body = failure(error);
      response.writeHead(
        body.code === "PERMISSION_DENIED"
          ? 403
          : body.code === "INVALID_INPUT"
            ? 400
            : body.code === "NOT_FOUND"
              ? 404
              : 500,
        { "Content-Type": "application/json", "Cache-Control": "no-store" },
      );
      response.end(JSON.stringify({ error: body }));
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const json = (response: http.ServerResponse, value: unknown) => {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  const readBody = async (request: http.IncomingMessage): Promise<unknown> => {
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers["content-type"] ?? "",
      )
    )
      throw new RiloomError("INVALID_INPUT", "请求内容必须为 JSON");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of request) {
      const chunk = Buffer.from(value as Uint8Array);
      length += chunk.length;
      if (length > 24 * 1024 * 1024)
        throw new RiloomError("INVALID_INPUT", "请求内容过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new RiloomError("INVALID_INPUT", "JSON 无法解析");
    }
  };
  const cookieGrant = (request: http.IncomingMessage) => {
    const token = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("riloom="))
      ?.slice(7);
    return validGrant(token);
  };
  async function handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    )
      throw new RiloomError("PERMISSION_DENIED", "请求来源不属于当前工作区");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const target = new URL(request.url ?? "/", origin);
    if (request.method === "POST") {
      if (request.headers.origin !== origin)
        throw new RiloomError("PERMISSION_DENIED", "写请求需要同源授权");
      if (target.pathname === "/api/v1/session") {
        const body = (await readBody(request)) as { token?: unknown };
        if (!body || typeof body.token !== "string")
          throw new RiloomError("PERMISSION_DENIED", "启动链接已失效");
        const ticket = tickets.get(body.token);
        tickets.delete(body.token);
        if (!ticket || ticket.expiry < Date.now())
          throw new RiloomError("PERMISSION_DENIED", "启动链接已失效");
        const grant = createGrant();
        response.setHeader(
          "Set-Cookie",
          "riloom=" + grant.token + "; HttpOnly; SameSite=Strict; Path=/",
        );
        json(response, {
          workspaceId: workspace.workspaceId,
          csrf: grant.csrf,
        });
        return;
      }
      const grant = cookieGrant(request);
      if (
        typeof request.headers["x-riloom-csrf"] !== "string" ||
        !equal(grant.csrf, request.headers["x-riloom-csrf"])
      )
        throw new RiloomError("PERMISSION_DENIED", "写请求校验失败");
      if (target.pathname !== "/api/v1/commands")
        throw new RiloomError("NOT_FOUND", "请求入口不存在");
      json(response, execute(grant, await readBody(request)));
      return;
    }
    if (request.method !== "GET")
      throw new RiloomError("INVALID_INPUT", "请求方法不受支持");
    if (target.pathname === "/api/v1/session") {
      const grant = cookieGrant(request);
      json(response, { workspaceId: workspace.workspaceId, csrf: grant.csrf });
      return;
    }
    if (target.pathname === "/api/v1/events") {
      const grant = cookieGrant(request),
        projectId = target.searchParams.get("projectId");
      let cursor = Number(
        request.headers["last-event-id"] ??
          target.searchParams.get("after") ??
          0,
      );
      if (!projectId || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new RiloomError("INVALID_INPUT", "事件查询参数无效");
      checkProject(grant, projectId);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      const poll = () => {
        if (response.writableNeedDrain) return;
        try {
          validGrant(grant.token);
          checkProject(grant, projectId);
          const events = workspace
            .openProject(projectId)
            .read((tx) => tx.events(cursor, 100));
          for (const event of events) {
            cursor = event.sequence;
            if (
              !response.write(
                "id: " + cursor + "\ndata: " + JSON.stringify(event) + "\n\n",
              )
            )
              break;
          }
        } catch {
          response.end();
        }
      };
      const timer = setInterval(poll, 250);
      eventTimers.add(timer);
      response.on("close", () => {
        clearInterval(timer);
        eventTimers.delete(timer);
      });
      poll();
      return;
    }
    const projectMatch =
      /^\/api\/v1\/projects\/([A-Za-z0-9_.:-]+)(?:\/operations(?:\/([A-Za-z0-9_.:-]+))?)?$/.exec(
        target.pathname,
      );
    if (projectMatch) {
      const grant = cookieGrant(request),
        projectId = projectMatch[1]!;
      checkProject(grant, projectId);
      if (projectMatch[2]) {
        const operation = workspace
          .openProject(projectId)
          .read((tx) => tx.receiptById(projectMatch[2]!));
        if (!operation) throw new RiloomError("NOT_FOUND", "请求回执不存在");
        json(response, operation);
        return;
      }
      const lookup = target.searchParams.get("requestId");
      const command = lookup
        ? "riloom.project.getOperation"
        : "riloom.project.get";
      json(
        response,
        execute(grant, {
          requestId: randomUUID(),
          command,
          commandVersion: "1.0.0",
          projectId,
          arguments: lookup ? { requestId: lookup } : {},
        }),
      );
      return;
    }
    const workspaceMatch =
      /^\/api\/v1\/workspaces\/([A-Za-z0-9_.:-]+)\/operations$/.exec(
        target.pathname,
      );
    if (workspaceMatch) {
      const grant = cookieGrant(request),
        lookup = target.searchParams.get("requestId");
      if (!lookup) throw new RiloomError("INVALID_INPUT", "需要原请求标识");
      json(
        response,
        execute(grant, {
          requestId: randomUUID(),
          command: "riloom.workspace.getOperation",
          commandVersion: "1.0.0",
          workspaceId: workspaceMatch[1],
          arguments: { requestId: lookup },
        }),
      );
      return;
    }
    if (target.pathname.startsWith("/api/"))
      throw new RiloomError("NOT_FOUND", "请求入口不存在");
    const name =
      target.pathname === "/" ? "index.html" : target.pathname.slice(1);
    if (
      name !== "index.html" &&
      !/^assets\/[A-Za-z0-9_.-]+\.(js|css|svg)$/.test(name)
    )
      throw new RiloomError("NOT_FOUND", "页面不存在");
    const staticRoot = fileURLToPath(
      new URL("../../studio/dist/", import.meta.url),
    );
    let data: Buffer;
    try {
      data = readFileSync(path.join(staticRoot, name));
    } catch {
      throw new RiloomError("NOT_FOUND", "工作台文件不可用，请先构建项目");
    }
    const extension = path.extname(name),
      type =
        extension === ".js"
          ? "text/javascript"
          : extension === ".css"
            ? "text/css"
            : extension === ".svg"
              ? "image/svg+xml"
              : "text/html";
    response.writeHead(200, {
      "Content-Type": type + "; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(data);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
  } catch (error) {
    stopping = true;
    markReady();
    for (const wire of wires) wire.close();
    await pipe.close();
    workspace.close();
    ownership.close();
    if (socketDirectory) rmdirSync(socketDirectory);
    throw error;
  }
  origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  markReady();
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closePromise ??= closeActual());
  }
  async function closeActual(): Promise<void> {
    stopping = true;
    grants.clear();
    tickets.clear();
    for (const timer of eventTimers) clearInterval(timer);
    for (const connection of wires) connection.close();
    await pipe.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    workspace.close();
    ownership.close();
    if (socketDirectory) rmdirSync(socketDirectory);
  }
  return {
    workspaceId: workspace.workspaceId,
    generation,
    url: origin,
    endpoint,
    close,
  };
}
