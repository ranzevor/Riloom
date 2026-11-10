// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { RiloomClient } from "../packages/sdk/dist/index.js";
import type { ProjectState } from "../packages/contracts/dist/index.js";
import {
  request,
  temporaryDirectory,
  removeDirectory,
  success,
} from "./helpers.js";

const mounted = vi.hoisted(() => ({
  root: null as { unmount(): void } | null,
}));
vi.mock("react-dom/client", async (original) => {
  const module = await original<{
    createRoot(container: Element): { unmount(): void };
  }>();
  return {
    createRoot(container: Element) {
      const root = module.createRoot(container);
      mounted.root = root;
      return root;
    },
  };
});
let directory: string | undefined,
  worker: ChildProcess | undefined,
  stopped: Promise<void> | undefined,
  client: RiloomClient | undefined;
afterEach(async () => {
  mounted.root?.unmount();
  vi.unstubAllGlobals();
  client?.close();
  if (worker && worker.exitCode === null && worker.signalCode === null)
    worker.send?.({ type: "shutdown" });
  await stopped;
  if (directory) removeDirectory(directory);
});
it("runs the Studio entry point and saves form input through the HTTP service", async () => {
  directory = temporaryDirectory();
  const workspace = path.join(directory, "workspace");
  worker = spawn(
    process.execPath,
    [path.resolve("apps/service/dist/main.js"), "--workspace", workspace],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        LOCALAPPDATA: path.join(directory, "state"),
        XDG_STATE_HOME: path.join(directory, "state"),
      },
    },
  );
  stopped = new Promise((resolve) => {
    worker!.once("exit", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker!.kill();
      reject(new Error("Service startup timed out"));
    }, 10000);
    worker!.on("message", (message) => {
      if (message && typeof message === "object" && "type" in message) {
        clearTimeout(timer);
        if (message.type === "ready") resolve();
        else reject(new Error("Service startup failed"));
      }
    });
    worker!.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  client = await RiloomClient.connect(workspace);
  const launch = new URL(await client.browserLink()),
    origin = launch.origin,
    nativeFetch = globalThis.fetch;
  let cookie = "";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.method === "POST") headers.set("Origin", origin);
    if (cookie) headers.set("Cookie", cookie);
    const response = await nativeFetch(new URL(input, origin), {
      ...init,
      headers,
    });
    const value = response.headers.get("set-cookie");
    if (value) cookie = value.split(";")[0]!;
    return response;
  });
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: (() => void) | null = null;
      close() {}
    },
  );
  document.body.innerHTML = '<div id="root"></div>';
  sessionStorage.clear();
  window.location.hash = launch.hash;
  await import("../apps/studio/src/main.js");
  await vi.waitFor(() =>
    expect(document.querySelector(".welcome h1")?.textContent).toBe(
      "从一个工程开始",
    ),
  );
  (
    document.querySelector('[aria-label="新建工程"]') as HTMLButtonElement
  ).click();
  await vi.waitFor(() =>
    expect(document.querySelector(".create-form")).not.toBeNull(),
  );
  const enter = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const inputs =
    document.querySelectorAll<HTMLInputElement>(".create-form input");
  enter(inputs[0]!, "页面工程");
  enter(inputs[1]!, "page.riloom");
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector(".project-name")?.textContent).toBe(
      "页面工程",
    ),
  );
  (
    document.querySelector('[aria-label="添加参数"]') as HTMLButtonElement
  ).click();
  await vi.waitFor(() =>
    expect(document.querySelector(".properties input")).not.toBeNull(),
  );
  const fields =
    document.querySelectorAll<HTMLInputElement>(".properties input");
  enter(fields[0]!, "呼吸");
  enter(fields[5]!, "0.5");
  const button = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(".header-actions button"),
    ].find((item) => item.textContent === label)!;
  button("保存草稿").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".save-state")?.textContent).toBe(
      "草稿已保存，待应用",
    ),
  );
  button("应用草稿").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".save-state")?.textContent).toBe(
      "工程已保存",
    ),
  );
  const listed = success(
    await client.execute(
      request("riloom.project.list", {}, { workspaceId: client.workspaceId }),
    ),
  );
  const projectId = (listed.result.items as { projectId: string }[])[0]!
    .projectId;
  const state = success(
    await client.execute(request("riloom.project.get", {}, { projectId })),
  ).result.project as ProjectState;
  expect(state.revision).toBe(1);
  expect(state.model.parameters).toMatchObject([{ name: "呼吸", value: 0.5 }]);
  expect(document.querySelector(".error")).toBeNull();

  const openBackups = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".header-actions button")]
      .find((item) => item.textContent === "备份与恢复")!
      .click();
  const panelButton = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(".backup-panel button"),
    ].find((item) => item.textContent === label)!;
  openBackups();
  await vi.waitFor(() =>
    expect(document.querySelector(".backup-panel")).not.toBeNull(),
  );
  panelButton("备份当前工程").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".backup-message")?.textContent).toBe(
      "工程备份已保存",
    ),
  );
  (
    document.querySelector('[aria-label="关闭备份与恢复"]') as HTMLButtonElement
  ).click();
  enter(
    document.querySelectorAll<HTMLInputElement>(".properties input")[5]!,
    "0.75",
  );
  button("应用草稿").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".save-state")?.textContent).toBe(
      "工程已保存",
    ),
  );
  openBackups();
  await vi.waitFor(() =>
    expect(panelButton("恢复选定备份").disabled).toBe(false),
  );
  panelButton("恢复选定备份").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".backup-message")?.textContent).toBe(
      "工程已恢复到新目录",
    ),
  );
  const reopened = success(
    await client.execute(
      request(
        "riloom.project.open",
        { projectId },
        { workspaceId: client.workspaceId },
      ),
    ),
  ).result.project as ProjectState;
  expect(reopened.revision).toBe(1);
  expect(reopened.model.parameters[0]!.value).toBe(0.5);
  expect(reopened.storageGeneration).not.toBe(state.storageGeneration);
});
