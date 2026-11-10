#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RiloomClient } from "@riloom/sdk";
import { serviceEntryPoint } from "@riloom/service";
import { runMcp } from "@riloom/mcp";
import { RiloomError, type CommandRequest } from "@riloom/contracts";

async function connect(workspace: string): Promise<RiloomClient> {
  mkdirSync(workspace, { recursive: true });
  try {
    return await RiloomClient.connect(workspace);
  } catch (error) {
    if (!(error instanceof RiloomError) || error.code !== "RESOURCE_BUSY")
      throw error;
  }
  const child = spawn(
    process.execPath,
    [serviceEntryPoint, "--workspace", workspace],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new RiloomError("RESOURCE_BUSY", "工作区服务启动超时"));
    }, 15000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("message", (message) => {
      if (!message || typeof message !== "object" || !("type" in message))
        return;
      if (message.type === "ready" || message.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  if (child.connected) child.disconnect();
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return await RiloomClient.connect(workspace);
    } catch (error) {
      if (!(error instanceof RiloomError) || error.code !== "RESOURCE_BUSY")
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new RiloomError("RESOURCE_BUSY", "无法启动或连接工作区服务");
}
async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw[0] === "--") raw.shift();
  const { values, positionals } = parseArgs({
    args: raw,
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      json: { type: "boolean" },
      input: { type: "string" },
      name: { type: "string" },
      directory: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      project: { type: "string" },
    },
  });
  if (!values.workspace)
    throw new RiloomError("INVALID_INPUT", "请用 --workspace 指定工作区目录");
  const client = await connect(path.resolve(values.workspace));
  if (positionals[0] === "mcp") {
    await runMcp(client);
    return;
  }
  try {
    if (!positionals.length || positionals[0] === "studio") {
      const url = await client.browserLink();
      console.log(values.json ? JSON.stringify({ url }) : url);
      return;
    }
    if (positionals[0] === "stop") {
      await client.shutdown();
      console.log(
        values.json ? JSON.stringify({ stopping: true }) : "工作区服务正在停止",
      );
      return;
    }
    let request: CommandRequest;
    if (positionals[0] === "call" && values.input)
      request = JSON.parse(
        readFileSync(values.input, "utf8"),
      ) as CommandRequest;
    else {
      const operation = positionals.join(" ");
      const command =
        operation === "project create"
          ? "riloom.project.create"
          : operation === "project list"
            ? "riloom.project.list"
            : operation === "project get"
              ? "riloom.project.get"
              : "";
      if (!command)
        throw new RiloomError(
          "INVALID_INPUT",
          "请选择 studio、mcp、project create/list/get、call 或 stop",
        );
      request = {
        requestId: randomUUID(),
        command,
        commandVersion: "1.0.0",
        ...(values.project
          ? { projectId: values.project }
          : { workspaceId: client.workspaceId }),
        arguments:
          operation === "project create"
            ? {
                name: values.name ?? "新工程",
                directory: values.directory ?? "新工程.riloom",
                canvas: {
                  width: Number(values.width ?? 1024),
                  height: Number(values.height ?? 1024),
                },
              }
            : {},
      };
    }
    const result = await client.execute(request);
    console.log(JSON.stringify(result, null, values.json ? undefined : 2));
    if (result.status === "failed")
      process.exitCode = result.error?.code === "REVISION_CONFLICT" ? 3 : 5;
  } finally {
    client.close();
  }
}
void main().catch((error) => {
  const code = error instanceof RiloomError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof RiloomError ? error.message : "命令执行失败";
  if (process.argv.includes("--json"))
    console.log(JSON.stringify({ error: { code, message } }));
  else console.error(message);
  process.exitCode =
    code === "INVALID_INPUT"
      ? 2
      : code === "REVISION_CONFLICT"
        ? 3
        : code === "RESOURCE_BUSY"
          ? 4
          : 5;
});
