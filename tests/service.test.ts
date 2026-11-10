import { afterEach, describe, expect, it } from "vitest";
import { once, EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  startService,
  type RunningService,
} from "../apps/service/dist/index.js";
import { RiloomClient } from "../packages/sdk/dist/index.js";
import {
  connectPipe,
  FramedConnection,
  maxFrameBytes,
  OwnerLock,
  type Wire,
} from "../packages/platform/dist/index.js";
import {
  temporaryDirectory,
  removeDirectory,
  request,
  success,
  parameter,
} from "./helpers.js";
import type {
  Draft,
  Candidate,
  Receipt,
} from "../packages/contracts/dist/index.js";

let directory: string | undefined, service: RunningService | undefined;
const clients: RiloomClient[] = [];
const transports: StdioClientTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close();
  for (const client of clients.splice(0)) client.close();
  await service?.close();
  service = undefined;
  if (directory) removeDirectory(directory);
  directory = undefined;
});
async function setup() {
  directory = temporaryDirectory();
  const workspace = path.join(directory, "workspace");
  const storage = { lockDirectory: path.join(directory, "locks") };
  service = await startService({ workspace, storage });
  const client = await RiloomClient.connect(workspace);
  clients.push(client);
  return { workspace, storage, client, running: service };
}
async function browser(client: RiloomClient) {
  const url = new URL(await client.browserLink()),
    origin = url.origin;
  const response = await fetch(origin + "/api/v1/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: url.hash.slice(1) }),
  });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { csrf: string };
  return {
    origin,
    token: url.hash.slice(1),
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrf: session.csrf,
  };
}
function rawHttp(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
  });
}
describe("workspace service transports", () => {
  it("accepts new clients after a connection closes before its handshake", async () => {
    const { running, workspace } = await setup();
    const abandoned = await connectPipe(running.endpoint);
    abandoned.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const connected = await RiloomClient.connect(workspace);
    clients.push(connected);
    expect(
      (
        await connected.execute(
          request(
            "riloom.project.list",
            {},
            { workspaceId: connected.workspaceId },
          ),
        )
      ).status,
    ).toBe("succeeded");
  });
  it("serves one model through IPC, HTTP and real MCP stdio", async () => {
    const { client, workspace, running } = await setup();
    const session = await browser(client);
    const created = success(
      await client.execute(
        request(
          "riloom.project.create",
          {
            name: "共享工程",
            directory: "shared.riloom",
            canvas: { width: 256, height: 256 },
          },
          { workspaceId: client.workspaceId },
        ),
      ),
    );
    const projectId = created.result.projectId as string;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url)),
        "mcp",
        "--workspace",
        workspace,
      ],
      stderr: "pipe",
    });
    transports.push(transport);
    const mcp = new Client({ name: "riloom-integration", version: "1.0.0" });
    await mcp.connect(transport);
    const catalog = await mcp.listTools();
    expect(
      catalog.tools.some((tool) => tool.name === "riloom.project.saveDraft"),
    ).toBe(true);
    const base = await client.execute(
      request("riloom.project.get", {}, { projectId }),
    );
    const state = base.result.project as { stateHash: unknown };
    const input = request(
      "riloom.project.saveDraft",
      {
        draftId: "shared-draft",
        editorId: "mcp-editor",
        baseRevision: 0,
        baseStateHash: state.stateHash,
        editGeneration: 1,
        changes: [{ type: "addParameter", after: parameter() }],
      },
      { projectId, expectedDraftVersion: 0 },
    );
    const { command: toolName, ...arguments_ } = input;
    const saved = await mcp.callTool({ name: toolName, arguments: arguments_ });
    expect(saved.isError).toBe(false);
    const draft = (saved.structuredContent as unknown as Receipt).result
      .draft as Draft;
    const candidate = success(
      await client.execute(
        request(
          "riloom.project.prepareDraft",
          { draftId: draft.draftId },
          { projectId, expectedDraftVersion: draft.draftVersion },
        ),
      ),
    ).result.candidate as Candidate;
    const applied = await fetch(session.origin + "/api/v1/commands", {
      method: "POST",
      headers: {
        Origin: session.origin,
        Cookie: session.cookie,
        "Content-Type": "application/json",
        "X-Riloom-CSRF": session.csrf,
      },
      body: JSON.stringify(
        request(
          "riloom.project.apply",
          { draftId: draft.draftId, candidateId: candidate.candidateId },
          {
            projectId,
            expectedDraftVersion: 1,
            expectedRevision: 0,
            expectedStateHash: state.stateHash as never,
          },
        ),
      ),
    });
    expect(success((await applied.json()) as Receipt).afterRevision).toBe(1);
    const queried = await fetch(
      session.origin + "/api/v1/projects/" + projectId,
      { headers: { Cookie: session.cookie } },
    );
    expect(((await queried.json()) as Receipt).result.project).toMatchObject({
      revision: 1,
      model: { parameters: [parameter()] },
    });
    await mcp.close();
    expect(
      (await client.execute(request("riloom.project.get", {}, { projectId })))
        .result.project,
    ).toMatchObject({ revision: 1 });
    expect((await fetch(running.url)).status).toBe(200);
  });
  it("rejects untrusted Host, Origin, missing CSRF and reused launch tokens", async () => {
    const { client, running } = await setup(),
      session = await browser(client);
    expect(await rawHttp(running.url, "attacker.invalid")).toBe(403);
    const endpoint = session.origin + "/api/v1/commands";
    const body = JSON.stringify(
      request("riloom.project.list", {}, { workspaceId: client.workspaceId }),
    );
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: "https://attacker.invalid",
            Cookie: session.cookie,
            "Content-Type": "application/json",
            "X-Riloom-CSRF": session.csrf,
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: session.origin,
            Cookie: session.cookie,
            "Content-Type": "application/json",
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(session.origin + "/api/v1/session", {
          method: "POST",
          headers: {
            Origin: session.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: session.token }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: session.origin,
            Cookie: session.cookie,
            "Content-Type": "application/json",
            "X-Riloom-CSRF": session.csrf,
          },
          body,
        })
      ).status,
    ).toBe(200);
  });
  it("rejects a second owner and releases locks after a failed HTTP listen", async () => {
    const { workspace, storage, running } = await setup();
    await expect(startService({ workspace, storage })).rejects.toThrow("使用");
    const other = path.join(directory!, "other");
    await expect(
      startService({
        workspace: other,
        storage,
        port: Number(new URL(running.url).port),
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    const recovered = await startService({ workspace: other, storage });
    await recovered.close();
  });
  it("replays persisted project events across reconnect and service restart", async () => {
    const { client, running, workspace, storage } = await setup(),
      session = await browser(client);
    const created = success(
      await client.execute(
        request(
          "riloom.project.create",
          {
            name: "事件工程",
            directory: "events.riloom",
            canvas: { width: 256, height: 256 },
          },
          { workspaceId: client.workspaceId },
        ),
      ),
    );
    const projectId = created.result.projectId as string,
      stateHash = created.result.stateHash;
    await client.execute(
      request(
        "riloom.project.saveDraft",
        {
          draftId: "events-draft",
          editorId: "editor",
          baseRevision: 0,
          baseStateHash: stateHash,
          editGeneration: 1,
          changes: [],
        },
        { projectId, expectedDraftVersion: 0 },
      ),
    );
    const response = await fetch(
      running.url + "/api/v1/events?projectId=" + projectId + "&after=0",
      { headers: { Cookie: session.cookie } },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(
      '"type":"draft.saved"',
    );
    await reader.cancel();
    client.close();
    await running.close();
    service = await startService({ workspace, storage });
    const restarted = await RiloomClient.connect(workspace);
    clients.push(restarted);
    const fresh = await browser(restarted);
    expect(
      (
        await fetch(service.url + "/api/v1/session", {
          headers: { Cookie: session.cookie },
        })
      ).status,
    ).toBe(403);
    const replay = await fetch(
      service.url + "/api/v1/events?projectId=" + projectId + "&after=0",
      { headers: { Cookie: fresh.cookie } },
    );
    const replayReader = replay.body!.getReader();
    expect(
      new TextDecoder().decode((await replayReader.read()).value),
    ).toContain('"sequence":1');
    await replayReader.cancel();
  });
  it("rejects a discovered endpoint with a different operating-system process", async () => {
    const { running, storage } = await setup();
    const fakeWorkspace = path.join(directory!, "fake");
    const isolated = await startService({ workspace: fakeWorkspace, storage });
    await isolated.close();
    const fake = new OwnerLock(
      path.join(fakeWorkspace, ".riloom", "owner.sqlite"),
      {
        pid: process.pid + 1000000,
        generation: running.generation,
        endpoint: running.endpoint,
      },
    );
    try {
      await expect(RiloomClient.connect(fakeWorkspace)).rejects.toThrow(
        "所有者不一致",
      );
    } finally {
      fake.close();
    }
  });
  it("starts through the CLI, reuses the same service and stops cleanly", async () => {
    directory = temporaryDirectory();
    const workspace = path.join(directory, "cli");
    const entry = fileURLToPath(
      new URL("../apps/cli/dist/index.js", import.meta.url),
    );
    const run = async (...args: string[]) => {
      const child = spawn(
        process.execPath,
        [entry, ...args, "--workspace", workspace, "--json"],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            LOCALAPPDATA: path.join(directory!, "state"),
            XDG_STATE_HOME: path.join(directory!, "state"),
          },
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const [code] = await once(child, "exit");
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout) as Receipt;
    };
    try {
      const created = await run(
        "project",
        "create",
        "--name",
        "命令行工程",
        "--directory",
        "cli.riloom",
      );
      expect(
        (
          await run(
            "project",
            "get",
            "--project",
            created.result.projectId as string,
          )
        ).result.project,
      ).toMatchObject({ revision: 0, model: { name: "命令行工程" } });
    } finally {
      const client = await RiloomClient.connect(workspace);
      await client.shutdown();
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
});

describe("internal framing", () => {
  it("accepts fragmented frames and rejects oversized or invalid UTF-8 input", async () => {
    class TestWire extends EventEmitter {
      peerPid = process.pid;
      peerUser = "test";
      closed = false;
      async send() {}
      close() {
        this.closed = true;
        this.emit("close");
      }
    }
    const wire = new TestWire(),
      connection = new FramedConnection(wire as Wire),
      messages: unknown[] = [];
    connection.on("message", (value) => messages.push(value));
    const body = Buffer.from('{"kind":"message"}'),
      header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    const frame = Buffer.concat([header, body]);
    wire.emit("data", frame.subarray(0, 2));
    wire.emit("data", frame.subarray(2));
    expect(messages).toEqual([{ kind: "message" }]);
    const invalid = Buffer.from([1, 0, 0, 0, 255]);
    wire.emit("data", invalid);
    expect(wire.closed).toBe(true);
    const other = new TestWire();
    new FramedConnection(other as Wire);
    header.writeUInt32LE(maxFrameBytes + 1);
    other.emit("data", header);
    expect(other.closed).toBe(true);
  });
});
