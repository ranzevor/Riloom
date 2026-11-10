import type { Asset, DrawItem, ProjectModel } from "@riloom/contracts";
import { orderedDrawItems } from "@riloom/core";

export interface PixelSource {
  asset: Asset;
  data: Uint8Array;
}
export type ScenePixels = ReadonlyMap<string, PixelSource>;
export function channelAt(source: PixelSource, index: number): number {
  if (source.asset.bitDepth === 8) return source.data[index]! / 255;
  return (
    new DataView(
      source.data.buffer,
      source.data.byteOffset,
      source.data.byteLength,
    ).getUint16(index * 2, true) / 65535
  );
}
function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function srgb(value: number): number {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
}
export function hitTest(
  items: readonly DrawItem[],
  sources: ScenePixels,
  x: number,
  y: number,
): string | null {
  for (const item of orderedDrawItems(items).reverse()) {
    const source = sources.get(item.assetId);
    if (!item.visible || !item.opacity || !source) continue;
    const px = Math.floor(x - item.x),
      py = Math.floor(y - item.y);
    if (
      px >= 0 &&
      py >= 0 &&
      px < source.asset.width &&
      py < source.asset.height &&
      channelAt(source, (py * source.asset.width + px) * 4 + 3) > 0
    )
      return item.id;
  }
  return null;
}
export function sampleComposite(
  items: readonly DrawItem[],
  sources: ScenePixels,
  x: number,
  y: number,
): [number, number, number, number] {
  let red = 0,
    green = 0,
    blue = 0,
    alpha = 0;
  for (const item of orderedDrawItems(items)) {
    const source = sources.get(item.assetId);
    if (!source || !item.visible) continue;
    const px = Math.floor(x - item.x),
      py = Math.floor(y - item.y);
    if (
      px < 0 ||
      py < 0 ||
      px >= source.asset.width ||
      py >= source.asset.height
    )
      continue;
    const at = (py * source.asset.width + px) * 4;
    const coverage = channelAt(source, at + 3) * item.opacity;
    red = linear(channelAt(source, at)) * coverage + red * (1 - coverage);
    green =
      linear(channelAt(source, at + 1)) * coverage + green * (1 - coverage);
    blue = linear(channelAt(source, at + 2)) * coverage + blue * (1 - coverage);
    alpha = coverage + alpha * (1 - coverage);
  }
  return alpha
    ? [srgb(red / alpha), srgb(green / alpha), srgb(blue / alpha), alpha]
    : [0, 0, 0, 0];
}
const vertex = `#version 300 es
in vec2 corner;
uniform vec2 viewport;
uniform vec2 origin;
uniform vec2 size;
out vec2 uv;
void main() {
  vec2 point = origin + corner * size;
  gl_Position = vec4(point / viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  uv = corner;
}`;
const fragment = `#version 300 es
precision highp float;
uniform sampler2D image;
uniform float opacity;
in vec2 uv;
out vec4 color;
vec3 linearColor(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, lessThanEqual(c, vec3(0.04045)));
}
void main() {
  vec4 pixel = texture(image, uv);
  float alpha = pixel.a * opacity;
  color = vec4(linearColor(pixel.rgb) * alpha, alpha);
}`;
const outputVertex = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() { gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0); uv = corner; }`;
const outputFragment = `#version 300 es
precision highp float;
uniform sampler2D image;
in vec2 uv;
out vec4 color;
void main() {
  vec4 pixel = texture(image, uv);
  vec3 c = pixel.a > 0.0 ? max(pixel.rgb / pixel.a, vec3(0.0)) : vec3(0.0);
  vec3 encoded = mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, lessThanEqual(c, vec3(0.0031308)));
  color = vec4(encoded * pixel.a, pixel.a);
}`;
export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export class SceneRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly maxTextureSize: number;
  private readonly layers: WebGLProgram;
  private readonly output: WebGLProgram;
  private readonly corners: WebGLBuffer;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly composite: WebGLTexture;
  private readonly textures = new Map<string, WebGLTexture>();
  private width = 0;
  private height = 0;
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl || !gl.getExtension("EXT_color_buffer_float"))
      throw new Error("视口需要支持浮点合成的 WebGL2");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.layers = this.program(vertex, fragment);
    this.output = this.program(outputVertex, outputFragment);
    this.corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.framebuffer = gl.createFramebuffer()!;
    this.composite = gl.createTexture()!;
  }
  private program(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl,
      program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        gl.deleteProgram(program);
        throw new Error("视口图形程序初始化失败");
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      throw new Error("视口着色器链接失败");
    }
    return program;
  }
  private bind(program: WebGLProgram): void {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    const corner = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(program, "image"), 0);
  }
  private sampling(texture: WebGLTexture): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  draw(model: ProjectModel, sources: ScenePixels, zoom = 1): ViewTransform {
    const gl = this.gl,
      canvas = this.canvas;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    let width = Math.max(
      1,
      Math.round(canvas.clientWidth * ratio || canvas.width),
    );
    let height = Math.max(
      1,
      Math.round(canvas.clientHeight * ratio || canvas.height),
    );
    const reduction = Math.min(
      1,
      Math.min(4096, this.maxTextureSize) / width,
      Math.min(4096, this.maxTextureSize) / height,
      Math.sqrt(8_000_000 / (width * height)),
    );
    width = Math.max(1, Math.round(width * reduction));
    height = Math.max(1, Math.round(height * reduction));
    if (width !== this.width || height !== this.height) {
      canvas.width = width;
      canvas.height = height;
      this.sampling(this.composite);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        width,
        height,
        0,
        gl.RGBA,
        gl.HALF_FLOAT,
        null,
      );
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("视口合成缓冲区分配失败，请缩小视口后重试");
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.composite,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("视口合成缓冲区创建失败");
      this.width = width;
      this.height = height;
    }
    const scale =
      Math.min(width / model.canvas.width, height / model.canvas.height) * zoom;
    const transform = {
      scale,
      x: (width - model.canvas.width * scale) / 2,
      y: (height - model.canvas.height * scale) / 2,
      width,
      height,
    };
    const used = new Set<string>();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.bind(this.layers);
    gl.uniform2f(gl.getUniformLocation(this.layers, "viewport"), width, height);
    for (const item of orderedDrawItems(model.drawItems ?? [])) {
      const source = sources.get(item.assetId);
      if (!item.visible || !item.opacity || !source) continue;
      if (
        source.asset.width > this.maxTextureSize ||
        source.asset.height > this.maxTextureSize
      )
        throw new Error(
          `图层“${item.name}”的尺寸为 ${source.asset.width}×${source.asset.height}，超过当前设备的纹理边长上限 ${this.maxTextureSize}。请缩小或拆分图层。`,
        );
      const key = [
        source.asset.pixels.hash.digest,
        source.asset.width,
        source.asset.height,
        source.asset.bitDepth,
      ].join(":");
      used.add(key);
      let texture = this.textures.get(key);
      if (!texture) {
        texture = gl.createTexture() ?? undefined;
        if (!texture)
          throw new Error(`图层“${item.name}”的纹理创建失败，请重试。`);
        try {
          this.sampling(texture);
          if (source.asset.bitDepth === 8)
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA8,
              source.asset.width,
              source.asset.height,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              source.data,
            );
          else {
            const pixels = new Float32Array(source.data.byteLength / 2);
            const view = new DataView(
              source.data.buffer,
              source.data.byteOffset,
              source.data.byteLength,
            );
            for (let i = 0; i < pixels.length; i++)
              pixels[i] = view.getUint16(i * 2, true) / 65535;
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA32F,
              source.asset.width,
              source.asset.height,
              0,
              gl.RGBA,
              gl.FLOAT,
              pixels,
            );
          }
          if (gl.getError() !== gl.NO_ERROR)
            throw new Error(`图层“${item.name}”的纹理上传失败，请重试。`);
        } catch (error) {
          gl.deleteTexture(texture);
          throw error;
        }
        this.textures.set(key, texture);
      } else this.sampling(texture);
      gl.uniform2f(
        gl.getUniformLocation(this.layers, "origin"),
        transform.x + item.x * scale,
        transform.y + item.y * scale,
      );
      gl.uniform2f(
        gl.getUniformLocation(this.layers, "size"),
        source.asset.width * scale,
        source.asset.height * scale,
      );
      gl.uniform1f(gl.getUniformLocation(this.layers, "opacity"), item.opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    for (const [key, texture] of this.textures)
      if (!used.has(key)) {
        gl.deleteTexture(texture);
        this.textures.delete(key);
      }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    this.bind(this.output);
    this.sampling(this.composite);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return transform;
  }
  dispose(): void {
    const gl = this.gl;
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    gl.deleteTexture(this.composite);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.corners);
    gl.deleteProgram(this.layers);
    gl.deleteProgram(this.output);
  }
}
