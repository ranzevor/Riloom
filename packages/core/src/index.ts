import {
  RiloomError,
  type Change,
  type Json,
  type Parameter,
  type ProjectModel,
} from "@riloom/contracts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  }
  throw new RiloomError("INVALID_INPUT", "数据包含不可保存的值");
}
export function validateParameter(parameter: Parameter): void {
  if (!parameter.name.trim() || parameter.name !== parameter.name.trim())
    throw new RiloomError("INVALID_INPUT", "参数名称首尾不能包含空白");
  if (
    ![parameter.min, parameter.default, parameter.max, parameter.value].every(
      Number.isFinite,
    )
  )
    throw new RiloomError("INVALID_INPUT", "参数必须为有限数值");
  if (
    parameter.min > parameter.max ||
    parameter.default < parameter.min ||
    parameter.default > parameter.max ||
    parameter.value < parameter.min ||
    parameter.value > parameter.max
  )
    throw new RiloomError(
      "INVALID_INPUT",
      "参数默认值和当前值必须位于取值范围内",
    );
}
export function validateModel(model: ProjectModel): void {
  if (model.formatVersion !== "1.0.0")
    throw new RiloomError("UNSUPPORTED_VERSION", "工程格式版本不受支持");
  if (!model.name.trim())
    throw new RiloomError("INVALID_INPUT", "请输入工程名称");
  if (
    !Number.isSafeInteger(model.canvas.width) ||
    !Number.isSafeInteger(model.canvas.height) ||
    model.canvas.width < 1 ||
    model.canvas.height < 1 ||
    model.canvas.width > 32768 ||
    model.canvas.height > 32768 ||
    model.canvas.width * model.canvas.height > 67108864
  )
    throw new RiloomError("INVALID_INPUT", "画布尺寸超出支持范围");
  const ids = new Set<string>();
  for (const parameter of model.parameters) {
    validateParameter(parameter);
    if (ids.has(parameter.id))
      throw new RiloomError("INVALID_INPUT", "参数标识重复");
    ids.add(parameter.id);
  }
}
export function applyChanges(
  source: ProjectModel,
  changes: Change[],
): { model: ProjectModel; inverse: Change[] } {
  const model = structuredClone(source);
  const inverse: Change[] = [];
  for (const change of changes) {
    if (change.type === "addParameter") {
      if (
        model.parameters.some((parameter) => parameter.id === change.after.id)
      )
        throw new RiloomError("REVISION_CONFLICT", "该参数已经存在");
      validateParameter(change.after);
      const index = change.index ?? model.parameters.length;
      if (index > model.parameters.length)
        throw new RiloomError("INVALID_INPUT", "参数插入位置无效");
      model.parameters.splice(index, 0, structuredClone(change.after));
      inverse.unshift({
        type: "removeParameter",
        before: structuredClone(change.after),
      });
    } else {
      const index = model.parameters.findIndex(
        (parameter) => parameter.id === change.before.id,
      );
      if (
        index < 0 ||
        canonicalJson(model.parameters[index]) !== canonicalJson(change.before)
      )
        throw new RiloomError(
          "REVISION_CONFLICT",
          "参数已被修改，请读取当前值",
          { parameterId: change.before.id },
        );
      if (change.type === "removeParameter") {
        model.parameters.splice(index, 1);
        inverse.unshift({
          type: "addParameter",
          after: structuredClone(change.before),
          index,
        });
      } else {
        if (change.after.id !== change.before.id)
          throw new RiloomError("INVALID_INPUT", "修改参数时必须保留标识");
        validateParameter(change.after);
        model.parameters[index] = structuredClone(change.after);
        inverse.unshift({
          type: "updateParameter",
          before: structuredClone(change.after),
          after: structuredClone(change.before),
        });
      }
    }
  }
  validateModel(model);
  if (canonicalJson(source) === canonicalJson(model))
    throw new RiloomError("INVALID_INPUT", "草稿没有可应用的修改");
  return { model, inverse };
}
export function asJson(value: unknown): Json {
  return JSON.parse(canonicalJson(value)) as Json;
}
