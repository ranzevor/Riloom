import { afterEach, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { PNG } from "pngjs";
import path from "node:path";
import {
  startService,
  type RunningService,
} from "../apps/service/dist/index.js";
import { RiloomClient } from "../packages/sdk/dist/index.js";
import {
  temporaryDirectory,
  removeDirectory,
  request,
  success,
} from "./helpers.js";

let directory: string | undefined,
  service: RunningService | undefined,
  browser: Browser | undefined,
  client: RiloomClient | undefined;
afterEach(async () => {
  if (browser) {
    for (const context of browser.contexts()) await context.close();
    await browser.close();
  }
  client?.close();
  await service?.close();
  if (directory) removeDirectory(directory);
});
function image(
  red: number,
  green: number,
  blue: number,
  alpha: number,
): Buffer {
  const data = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < data.length; i += 4)
    data.set([red, green, blue, alpha], i);
  return PNG.sync.write(
    Object.assign(new PNG(), { width: 64, height: 64, data, gamma: 0 }),
  );
}
it("imports PNG through Studio and renders real WebGL layers with linear alpha", async () => {
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
          name: "画布",
          directory: "canvas.riloom",
          canvas: { width: 256, height: 256 },
        },
        { workspaceId: client.workspaceId },
      ),
    ),
  );
  const projectId = created.result.projectId as string;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RILOOM_TEST_CHROMIUM
      ? { executablePath: process.env.RILOOM_TEST_CHROMIUM }
      : {}),
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors: string[] = [];
  page.on("requestfailed", (event) =>
    errors.push(event.failure()?.errorText ?? "request failed"),
  );

  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(await client.browserLink());
  try {
    await page
      .getByRole("button", { name: "画布", exact: false })
      .click({ timeout: 5000 });
  } catch {
    throw new Error(
      (await page.locator("body").innerText()) + "\\n" + errors.join("\\n"),
    );
  }
  await expect
    .poll(() =>
      page.getByRole("button", { name: "导入 PNG", exact: true }).isEnabled(),
    )
    .toBe(true);
  await page.getByLabel("PNG 文件", { exact: true }).setInputFiles({
    name: "红色.png",
    mimeType: "image/png",
    buffer: image(255, 0, 0, 255),
  });
  try {
    await page
      .getByRole("button", { name: "红色", exact: true })
      .waitFor({ timeout: 7000 });
  } catch {
    throw new Error(
      (await page.locator("body").innerText()) + errors.join(" | "),
    );
  }
  await page.getByRole("button", { name: "应用草稿", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "工程已保存",
  );
  await page.getByLabel("PNG 文件", { exact: true }).setInputFiles({
    name: "蓝色.png",
    mimeType: "image/png",
    buffer: image(0, 0, 255, 128),
  });
  await page.getByRole("button", { name: "蓝色", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "蓝色", exact: true }).waitFor();
  await page.getByRole("button", { name: "应用草稿", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "工程已保存",
  );
  const center = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[aria-label="模型画布"]',
      )!;
      const gl = canvas?.getContext("webgl2");
      if (!gl) return [];
      const old = gl.getParameter(
        gl.FRAMEBUFFER_BINDING,
      ) as WebGLFramebuffer | null;
      const texture = gl.getParameter(
        gl.TEXTURE_BINDING_2D,
      ) as WebGLTexture | null;
      const target = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      const data = new Float32Array(4);
      gl.readPixels(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
        gl.RGBA,
        gl.FLOAT,
        data,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, old);
      gl.deleteFramebuffer(target);
      return [...data];
    });
  await expect.poll(async () => (await center())[2]).toBeCloseTo(128 / 255, 2);
  const mixed = await center();
  expect(mixed[0]).toBeCloseTo(127 / 255, 2);
  expect(mixed[3]).toBeCloseTo(1, 3);
  await page.getByRole("button", { name: "隐藏 蓝色", exact: true }).click();
  await expect.poll(async () => (await center())[0]).toBeCloseTo(1, 3);
  await expect.poll(async () => (await center())[2]).toBeCloseTo(0, 3);
  await page.getByRole("button", { name: "蓝色", exact: true }).click();
  await page.getByLabel("图层不透明度").fill("0.25");
  await page.getByRole("button", { name: "显示 蓝色", exact: true }).click();
  await expect
    .poll(async () => (await center())[2])
    .toBeCloseTo((128 / 255) * 0.25, 2);
  await page.getByRole("button", { name: "下移", exact: true }).click();
  await expect.poll(async () => (await center())[0]).toBeCloseTo(1, 3);
  await page.getByRole("button", { name: "应用草稿", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "工程已保存",
  );
  const state = success(
    await client.execute(request("riloom.project.get", {}, { projectId })),
  ).result.project as {
    model: {
      assets: unknown[];
      drawItems: { visible: boolean; opacity: number }[];
    };
  };
  expect(state.model.assets).toHaveLength(2);
  expect(
    state.model.drawItems.some((item) => item.opacity === 0.25 && item.visible),
  ).toBe(true);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "工程已保存",
  );
  await expect.poll(async () => (await center())[2]).toBeCloseTo(128 / 255, 2);
  await page.getByRole("button", { name: "适合画布", exact: true }).click();
  await page.evaluate(() => {
    const gl = document
      .querySelector<HTMLCanvasElement>("canvas")!
      .getContext("webgl2")!;
    const loss = gl.getExtension("WEBGL_lose_context")!;
    loss.loseContext();
    setTimeout(() => loss.restoreContext(), 100);
  });
  await expect.poll(async () => (await center())[2]).toBeCloseTo(128 / 255, 2);
  expect(await page.locator(".viewport-message").count()).toBe(0);
});
