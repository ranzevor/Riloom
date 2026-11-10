#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RiloomClient } from "@riloom/sdk";
import { serviceEntryPoint } from "@riloom/service";
import { runMcp } from "@riloom/mcp";
import {
  RiloomError,
  type CommandRequest,
  type ProjectState,
  type RestorePlan,
} from "@riloom/contracts";

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
      backup: { type: "string" },
      source: { type: "string" },
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
    else if (positionals[0] === "asset" && positionals[1] === "import") {
      if (!values.source || !values.project)
        throw new RiloomError(
          "INVALID_INPUT",
          "请用 --source 和 --project 选择 PNG 文件及工程",
        );
      const info = lstatSync(values.source);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 16 * 1024 * 1024
      )
        throw new RiloomError(
          "INVALID_INPUT",
          "请选择 16 MiB 以内的 PNG 常规文件",
        );
      const opened = await client.execute({
        requestId: randomUUID(),
        command: "riloom.project.open",
        commandVersion: "1.0.0",
        workspaceId: client.workspaceId,
        arguments: { projectId: values.project },
      });
      if (opened.status === "failed")
        throw new RiloomError(opened.error!.code, opened.error!.message);
      const project = opened.result.project as ProjectState;
      request = {
        requestId: randomUUID(),
        command: "riloom.asset.import",
        commandVersion: "1.0.0",
        projectId: values.project,
        expectedDraftVersion: 0,
        expectedStorageGeneration: project.storageGeneration,
        arguments: {
          name:
            values.name ??
            path.basename(values.source, path.extname(values.source)),
          pngBase64: readFileSync(values.source).toString("base64"),
        },
      };
    } else if (positionals[0] === "backup") {
      const workspaceRequest = (
        command: string,
        args: Record<string, unknown>,
      ): CommandRequest => ({
        requestId: randomUUID(),
        command,
        commandVersion: "1.0.0",
        workspaceId: client.workspaceId,
        arguments: args,
      });
      const query = async (command: string, args: Record<string, unknown>) => {
        const receipt = await client.execute(workspaceRequest(command, args));
        if (receipt.status === "failed")
          throw new RiloomError(
            receipt.error!.code,
            receipt.error!.message,
            receipt.error!.details,
          );
        return receipt.result;
      };
      switch (positionals[1]) {
        case "list":
          request = workspaceRequest(
            "riloom.project.listBackups",
            values.project ? { projectId: values.project } : {},
          );
          break;
        case "create": {
          if (!values.project)
            throw new RiloomError("INVALID_INPUT", "请指定要备份的工程");
          const project = (
            await query("riloom.project.open", { projectId: values.project })
          ).project as ProjectState;
          request = workspaceRequest("riloom.project.backup", {
            projectId: values.project,
            expectedRevision: project.revision,
            expectedStateHash: project.stateHash,
            expectedStorageGeneration: project.storageGeneration,
          });
          break;
        }
        case "import":
          if (!values.source)
            throw new RiloomError("INVALID_INPUT", "请指定备份目录");
          request = workspaceRequest("riloom.project.importBackup", {
            directory: path.resolve(values.source),
          });
          break;
        case "restore": {
          if (!values.backup || !values.directory)
            throw new RiloomError(
              "INVALID_INPUT",
              "请指定备份和恢复后的工程目录",
            );
          const plan = (
            await query("riloom.project.prepareRestore", {
              backupId: values.backup,
            })
          ).plan as RestorePlan;
          request = workspaceRequest("riloom.project.restore", {
            backupId: values.backup,
            directory: values.directory,
            ...(plan.expectedProject
              ? { expectedProject: plan.expectedProject }
              : {}),
          });
          break;
        }
        default:
          throw new RiloomError(
            "INVALID_INPUT",
            "请选择 backup create、list、import 或 restore",
          );
      }
    } else {
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
          "请选择 studio、mcp、project create/list/get、asset import、backup、call 或 stop",
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
