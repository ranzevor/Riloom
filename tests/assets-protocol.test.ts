import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  startService,
  type RunningService,
} from "../apps/service/dist/index.js";
import { RiloomClient } from "../packages/sdk/dist/index.js";
import type {
  Receipt,
  Candidate,
  Asset,
  ProjectState,
} from "../packages/contracts/dist/index.js";
import {
  temporaryDirectory,
  removeDirectory,
  request,
  success,
} from "./helpers.js";

let directory: string | undefined,
  service: RunningService | undefined,
  client: RiloomClient | undefined,
  transport: StdioClientTransport | undefined;
afterEach(async () => {
  await transport?.close();
  client?.close();
  await service?.close();
  if (directory) removeDirectory(directory);
});
it("shares PNG imports across real MCP, HTTP, CLI and SDK entry points", async () => {
  directory = temporaryDirectory();
  const workspace = path.join(directory, "workspace");
  service = await startService({
    workspace,
    storage: { lockDirectory: path.join(directory, "locks") },
  });
  client = await RiloomClient.connect(workspace);
  const created = success(
    await client.execute(
      request(
        "riloom.project.create",
        {
          name: "素材",
          directory: "images.riloom",
          canvas: { width: 1024, height: 1024 },
        },
        { workspaceId: client.workspaceId },
      ),
    ),
  );
  const projectId = created.result.projectId as string;
  const data = Buffer.alloc(640 * 640 * 4);
  let seed = 1234567;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed >>> 24;
  }
  const source = PNG.sync.write(
    Object.assign(new PNG(), { width: 640, height: 640, data, gamma: 0 }),
  );
  expect(source.length).toBeGreaterThan(1048576);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve("apps/cli/dist/index.js"),
      "mcp",
      "--workspace",
      workspace,
    ],
    stderr: "pipe",
  });
  const mcp = new Client({ name: "asset-protocol", version: "1.0.0" });
  await mcp.connect(transport);
  const catalog = await mcp.listTools();
  expect(
    catalog.tools.find((tool) => tool.name === "riloom.asset.import")
      ?.annotations?.readOnlyHint,
  ).toBe(false);
  const input = request(
    "riloom.asset.import",
    { name: "噪声", pngBase64: source.toString("base64") },
    { projectId, expectedDraftVersion: 0 },
  );
  const { command, ...arguments_ } = input;
  const response = await mcp.callTool({ name: command, arguments: arguments_ });
  expect(
    response.isError,
    JSON.stringify(response.structuredContent ?? response.content).slice(
      0,
      1200,
    ),
  ).toBe(false);
  const imported = response.structuredContent as unknown as Receipt;
  expect(await client.execute(input)).toEqual(imported);
  const launch = new URL(await client.browserLink());
  const sessionResponse = await fetch(launch.origin + "/api/v1/session", {
    method: "POST",
    headers: { Origin: launch.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: launch.hash.slice(1) }),
  });
  const cookie = sessionResponse.headers.get("set-cookie")!.split(";")[0]!,
    session = (await sessionResponse.json()) as { csrf: string };
  const candidate = imported.result.candidate as Candidate;
  const state = success(
    await client.execute(request("riloom.project.get", {}, { projectId })),
  ).result.project as ProjectState;
  const applied = await fetch(launch.origin + "/api/v1/commands", {
    method: "POST",
    headers: {
      Origin: launch.origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-Riloom-CSRF": session.csrf,
    },
    body: JSON.stringify(
      request(
        "riloom.project.apply",
        { draftId: candidate.draftId, candidateId: candidate.candidateId },
        {
          projectId,
          expectedDraftVersion: 1,
          expectedRevision: state.revision,
          expectedStateHash: state.stateHash,
        },
      ),
    ),
  });
  expect(success((await applied.json()) as Receipt).afterRevision).toBe(1);
  const asset = imported.result.asset as Asset;
  const read = success(
    await client.execute(
      request("riloom.asset.read", { blob: asset.pixels }, { projectId }),
    ),
  );
  expect(Buffer.from(read.result.data as string, "base64")).toEqual(data);
  const filename = path.join(directory, "input.png");
  writeFileSync(filename, source);
  const child = spawn(
    process.execPath,
    [
      path.resolve("apps/cli/dist/index.js"),
      "asset",
      "import",
      "--workspace",
      workspace,
      "--project",
      projectId,
      "--source",
      filename,
      "--json",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => {
    stdout += value;
  });
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(exitCode, stderr + stdout).toBe(0);
  expect((JSON.parse(stdout) as Receipt).result.asset).toMatchObject({
    width: 640,
    height: 640,
  });
}, 60000);
