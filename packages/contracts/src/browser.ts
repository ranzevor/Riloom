export * from "./schema.js";
import {
  RiloomError,
  commands,
  type CommandRequest,
  type CommandName,
  type Asset,
  type DrawItem,
} from "./schema.js";
import {
  assetValidator,
  drawingValidator,
  requestValidators,
} from "./compiled.js";
export function validateRequest(value: unknown): CommandRequest {
  if (!value || typeof value !== "object")
    throw new RiloomError("INVALID_INPUT", "请求必须为对象");
  const name = (value as Record<string, unknown>).command;
  if (typeof name !== "string" || !Object.hasOwn(requestValidators, name))
    throw new RiloomError("UNSUPPORTED_FEATURE", "该命令当前不可用");
  const validate = requestValidators[name]!;
  if (!validate(value))
    throw new RiloomError("INVALID_INPUT", "输入不符合命令契约", {
      fields: (validate.errors ?? []).map((error) => ({
        path: error.instancePath,
        keyword: error.keyword,
      })),
    });
  return value as CommandRequest;
}
export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}

export function validateAssetShape(value: unknown): asserts value is Asset {
  if (!assetValidator(value))
    throw new RiloomError("INVALID_INPUT", "素材字段无效");
}
export function validateDrawItemShape(
  value: unknown,
): asserts value is DrawItem {
  if (!drawingValidator(value))
    throw new RiloomError("INVALID_INPUT", "绘画字段无效");
}
