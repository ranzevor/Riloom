import { PNG } from "pngjs";
import { RiloomError } from "@riloom/contracts";

export const maxPngBytes = 16 * 1024 * 1024;
export const maxImagePixels = 8_000_000;
export interface PixelImage {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  data: Uint8Array | Uint16Array;
}
export function inspectComponentRgba(image: PixelImage) {
  const { width, height, data } = image;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > maxImagePixels ||
    data.length !== width * height * 4
  )
    throw new RiloomError("INVALID_INPUT", "图像尺寸或像素长度无效");
  let left = width,
    top = height,
    right = 0,
    bottom = 0;
  let paintedPixels = 0,
    partialAlphaPixels = 0,
    hiddenRgbPixels = 0;
  const maximum = image.bitDepth === 16 ? 65535 : 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4,
        alpha = data[at + 3]!;
      if (!alpha) {
        if (data[at] || data[at + 1] || data[at + 2]) hiddenRgbPixels++;
        continue;
      }
      paintedPixels++;
      if (alpha < maximum) partialAlphaPixels++;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return {
    paintedPixels,
    partialAlphaPixels,
    hiddenRgbPixels,
    alphaBounds: paintedPixels
      ? { x: left, y: top, width: right - left, height: bottom - top }
      : null,
  };
}
export function decodePng(input: Uint8Array) {
  if (!input.byteLength || input.byteLength > maxPngBytes)
    throw new RiloomError("INVALID_INPUT", "PNG 文件须在 16 MiB 以内");
  const source = Buffer.from(input);
  if (
    source.length < 33 ||
    source.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new RiloomError("INVALID_INPUT", "请选择完整的 PNG 文件");
  const width = source.readUInt32BE(16),
    height = source.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 32768 ||
    height > 32768 ||
    width * height > maxImagePixels
  )
    throw new RiloomError("INVALID_INPUT", "PNG 尺寸须在 800 万像素以内");
  let offset = 8,
    gamma: number | undefined,
    srgb = false,
    ended = false;
  let chromaticity: Buffer | undefined;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset),
      kind = source.toString("ascii", offset + 4, offset + 8);
    if (length > source.length - offset - 12)
      throw new RiloomError("INVALID_INPUT", "PNG 数据块长度无效");
    const body = source.subarray(offset + 8, offset + 8 + length);
    if (kind === "iCCP" || kind === "cICP")
      throw new RiloomError(
        "UNSUPPORTED_FEATURE",
        "此 PNG 使用嵌入色彩配置，请先导出为 sRGB PNG",
      );
    if (kind === "acTL")
      throw new RiloomError("UNSUPPORTED_FEATURE", "请选择静态 PNG 图像");
    if (kind === "sRGB") {
      if (length !== 1 || body[0]! > 3)
        throw new RiloomError("INVALID_INPUT", "PNG sRGB 配置无效");
      srgb = true;
    }
    if (kind === "gAMA") {
      if (length !== 4)
        throw new RiloomError("INVALID_INPUT", "PNG 伽马配置无效");
      gamma = body.readUInt32BE(0);
    }
    if (kind === "cHRM") chromaticity = body;
    offset += length + 12;
    if (kind === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== source.length)
    throw new RiloomError("INVALID_INPUT", "PNG 数据不完整或包含多余内容");
  if (!srgb && gamma !== undefined && gamma !== 45455)
    throw new RiloomError(
      "UNSUPPORTED_FEATURE",
      "此 PNG 使用其他伽马配置，请先导出为 sRGB PNG",
    );
  if (!srgb && chromaticity) {
    const expected = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
    if (
      chromaticity.length !== 32 ||
      expected.some((value, i) => chromaticity!.readUInt32BE(i * 4) !== value)
    )
      throw new RiloomError(
        "UNSUPPORTED_FEATURE",
        "此 PNG 使用其他色域，请先导出为 sRGB PNG",
      );
  }
  try {
    const decoded = PNG.sync.read(source, {
      checkCRC: true,
      skipRescale: source[24] === 16,
    });
    const bitDepth = source[24] === 16 ? 16 : 8;
    const data = decoded.data as unknown as Uint8Array | Uint16Array;
    const image: PixelImage = { width, height, bitDepth, data };
    const analysis = inspectComponentRgba(image);
    const pixels = Buffer.alloc(data.length * (bitDepth / 8));
    if (bitDepth === 16) {
      for (let i = 0; i < data.length; i++)
        pixels.writeUInt16LE(data[i]!, i * 2);
    } else pixels.set(data);
    return {
      width,
      height,
      bitDepth: bitDepth as 8 | 16,
      pixels,
      analysis,
      colorSource: srgb ? ("srgb-chunk" as const) : ("assumed-srgb" as const),
    };
  } catch (error) {
    if (error instanceof RiloomError) throw error;
    throw new RiloomError("INVALID_INPUT", "PNG 无法解码，请检查文件内容");
  }
}
