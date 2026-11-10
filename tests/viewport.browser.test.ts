import { afterEach, expect, it } from "vitest";
import {
  chromium,
  type Browser,
  type BrowserServer,
  type Page,
} from "playwright";
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
  browserServer: BrowserServer | undefined,
  client: RiloomClient | undefined;
afterEach(async () => {
  try {
    if (browser)
      for (const context of browser.contexts()) await context.close();
  } finally {
    await browserServer?.kill();
    if (browserServer) {
      const process = browserServer.process();
      expect(process.exitCode !== null || process.signalCode !== null).toBe(
        true,
      );
    }
    client?.close();
    await service?.close();
    if (directory) removeDirectory(directory);
  }
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
async function setup() {
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
  browserServer = await chromium.launchServer({
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
  browser = await chromium.connect(browserServer.wsEndpoint());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  return { page, projectId, client };
}

it("imports PNG through Studio and renders real WebGL layers with linear alpha", async () => {
  const { page, projectId, client } = await setup();
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
  const center = () => samplePixel(page, 128, 128);
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

async function openProject(page: Page) {
  await page.goto(await client!.browserLink());
  await page.getByRole("button", { name: "画布", exact: false }).click();
  await expect
    .poll(() =>
      page.getByRole("button", { name: "导入 PNG", exact: true }).isEnabled(),
    )
    .toBe(true);
}
async function importImage(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("PNG 文件", { exact: true }).setInputFiles({
    name: name + ".png",
    mimeType: "image/png",
    buffer,
  });
  await page.getByRole("button", { name, exact: true }).waitFor();
}
async function samplePixel(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[aria-label="模型画布"]',
      )!;
      const gl = canvas.getContext("webgl2")!;
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
      const scale = Math.min(canvas.width / 256, canvas.height / 256);
      const data = new Float32Array(4);
      gl.readPixels(
        Math.floor((canvas.width - 256 * scale) / 2 + x * scale),
        canvas.height -
          1 -
          Math.floor((canvas.height - 256 * scale) / 2 + y * scale),
        1,
        1,
        gl.RGBA,
        gl.FLOAT,
        data,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, old);
      gl.deleteFramebuffer(target);
      return [...data];
    },
    { x, y },
  );
}
function sizedImage(
  width: number,
  height: number,
  bitDepth: 8 | 16,
  data: Buffer,
) {
  return PNG.sync.write(
    Object.assign(new PNG(), { width, height, data, gamma: 0 }),
    { bitDepth },
  );
}

it("keeps textures distinct for identical bytes with different dimensions and bit depths", async () => {
  const { page } = await setup();
  await openProject(page);
  const data = Buffer.alloc(64 * 32 * 4);
  for (let pixel = 0; pixel < data.length / 4; pixel++)
    data.set(pixel % 64 < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], pixel * 4);
  await importImage(page, "横图", sizedImage(64, 32, 8, data));
  await expect
    .poll(async () => (await samplePixel(page, 120, 116.5))[0])
    .toBeCloseTo(1, 3);
  await importImage(page, "竖图", sizedImage(32, 64, 8, data));
  await expect
    .poll(async () => (await samplePixel(page, 120, 116.5))[0])
    .toBeCloseTo(1, 3);
  await expect
    .poll(async () => (await samplePixel(page, 120, 117.5))[2])
    .toBeCloseTo(1, 3);
  await importImage(page, "深色通道", sizedImage(32, 32, 16, data));
  await expect
    .poll(async () => (await samplePixel(page, 120, 120))[1])
    .toBeGreaterThan(0.98);
  expect((await samplePixel(page, 120, 120))[0]).toBeLessThan(0.01);
  expect((await samplePixel(page, 120, 120))[2]).toBeLessThan(0.01);
});

it.each([8, 16] as const)(
  "reports an oversized %i-bit layer before uploading and recovers when hidden",
  async (bitDepth) => {
    const { page } = await setup();
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        return parameter === this.MAX_TEXTURE_SIZE
          ? 64
          : original.call(this, parameter);
      };
      const upload = WebGL2RenderingContext.prototype.texImage2D;
      const state = { oversizedUploads: 0 };
      Object.assign(window, { textureLimitTest: state });
      WebGL2RenderingContext.prototype.texImage2D = function (
        ...args: unknown[]
      ) {
        if (
          typeof args[3] === "number" &&
          typeof args[4] === "number" &&
          (args[3] > 64 || args[4] > 64)
        )
          state.oversizedUploads++;
        Reflect.apply(upload, this, args);
      };
    });
    await openProject(page);
    await importImage(
      page,
      "超限图层",
      sizedImage(
        65,
        16,
        bitDepth,
        Buffer.alloc(65 * 16 * 4 * (bitDepth / 8), 255),
      ),
    );
    await expect
      .poll(() => page.locator(".viewport-message").textContent())
      .toContain("65×16");
    const message = await page.locator(".viewport-message").textContent();
    expect(message).toContain("超限图层");
    expect(message).toContain("64");
    expect(message).toContain("缩小或拆分");
    expect(
      await page.evaluate(
        () => Reflect.get(window, "textureLimitTest").oversizedUploads,
      ),
    ).toBe(0);
    expect(
      await page
        .locator("canvas")
        .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
    ).toBeLessThanOrEqual(64);
    await page
      .getByRole("button", { name: "隐藏 超限图层", exact: true })
      .click();
    await expect.poll(() => page.locator(".viewport-message").count()).toBe(0);
    await importImage(page, "可显示图层", image(0, 255, 0, 255));
    await expect
      .poll(async () => (await samplePixel(page, 128, 128))[1])
      .toBeCloseTo(1, 3);
  },
);

it.each([8, 16] as const)(
  "discards a failed %i-bit upload and retries without a stale cache entry",
  async (bitDepth) => {
    const { page } = await setup();
    await page.addInitScript(() => {
      const upload = WebGL2RenderingContext.prototype.texImage2D;
      const remove = WebGL2RenderingContext.prototype.deleteTexture;
      const state = {
        failed: false,
        discarded: false,
        uploads: 0,
        texture: null as WebGLTexture | null,
      };
      Object.assign(window, { textureFailureTest: state });
      WebGL2RenderingContext.prototype.texImage2D = function (
        ...args: unknown[]
      ) {
        if (args[2] === this.RGBA8 || args[2] === this.RGBA32F) {
          state.uploads++;
          if (!state.failed) {
            state.failed = true;
            state.texture = this.getParameter(
              this.TEXTURE_BINDING_2D,
            ) as WebGLTexture;
            args[0] = 0;
          }
        }
        Reflect.apply(upload, this, args);
      };
      WebGL2RenderingContext.prototype.deleteTexture = function (texture) {
        if (texture === state.texture) state.discarded = true;
        remove.call(this, texture);
      };
    });
    await openProject(page);
    await importImage(
      page,
      "重试图层",
      sizedImage(
        64,
        64,
        bitDepth,
        Buffer.alloc(64 * 64 * 4 * (bitDepth / 8), 255),
      ),
    );
    await expect
      .poll(() => page.locator(".viewport-message").textContent())
      .toContain("上传失败");
    expect(
      await page.evaluate(
        () => Reflect.get(window, "textureFailureTest").discarded,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "隐藏 重试图层", exact: true })
      .click();
    await page
      .getByRole("button", { name: "显示 重试图层", exact: true })
      .click();
    await expect.poll(() => page.locator(".viewport-message").count()).toBe(0);
    await expect
      .poll(async () => (await samplePixel(page, 128, 128))[0])
      .toBeCloseTo(1, 3);
    expect(
      await page.evaluate(
        () => Reflect.get(window, "textureFailureTest").uploads,
      ),
    ).toBe(2);
  },
);
