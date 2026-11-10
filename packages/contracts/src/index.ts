import { Ajv2020 } from "ajv/dist/2020.js";
import {
  commands,
  requestSchema,
  RiloomError,
  assetSchema,
  drawItemSchema,
  type CommandRequest,
  type CommandName,
  type Asset,
  type DrawItem,
} from "./schema.js";
export * from "./schema.js";
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  strictNumbers: true,
});
const validators = new Map(
  Object.keys(commands).map((name) => [
    name,
    ajv.compile<CommandRequest>(requestSchema(name as CommandName)),
  ]),
);
export function validateRequest(value: unknown): CommandRequest {
  if (!value || typeof value !== "object")
    throw new RiloomError("INVALID_INPUT", "请求必须为对象");
  const name = (value as Record<string, unknown>).command;
  if (typeof name !== "string" || !validators.has(name))
    throw new RiloomError("UNSUPPORTED_FEATURE", "该命令当前不可用");
  const validate = validators.get(name)!;
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

const assetValidator = ajv.compile(assetSchema);
const drawingValidator = ajv.compile(drawItemSchema);
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
