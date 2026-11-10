import {
  RiloomError,
  type Change,
  type Json,
  type Parameter,
  type Asset,
  type DrawItem,
  type BlobRef,
  validateAssetShape,
  validateDrawItemShape,
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
  if (model.formatVersion !== "1.0.0" && model.formatVersion !== "1.1.0")
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
  if (
    model.formatVersion === "1.1.0" &&
    (!Array.isArray(model.assets) || !Array.isArray(model.drawItems))
  )
    throw new RiloomError("INVALID_INPUT", "工程缺少素材或绘画集合");
  if (
    model.formatVersion === "1.0.0" &&
    (model.assets !== undefined || model.drawItems !== undefined)
  )
    throw new RiloomError("INVALID_INPUT", "带素材的工程需要更新格式版本");
  const assetIds = new Set<string>();
  for (const asset of model.assets ?? []) {
    validateAssetShape(asset);
    if (
      !asset.name.trim() ||
      asset.width * asset.height > 8_000_000 ||
      asset.pixels.bytes !==
        asset.width * asset.height * 4 * (asset.bitDepth / 8) ||
      assetIds.has(asset.id)
    )
      throw new RiloomError("INVALID_INPUT", "素材尺寸、名称或标识无效");
    assetIds.add(asset.id);
  }
  const drawingIds = new Set<string>(),
    tokens = new Set<string>();
  for (const item of model.drawItems ?? []) {
    validateDrawItemShape(item);
    if (
      !item.name.trim() ||
      !assetIds.has(item.assetId) ||
      drawingIds.has(item.id) ||
      tokens.has(item.orderToken)
    )
      throw new RiloomError("INVALID_INPUT", "绘画引用、名称或排序标识无效");
    drawingIds.add(item.id);
    tokens.add(item.orderToken);
  }
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
    if (change.type === "setFormat") {
      if (model.formatVersion !== change.before)
        throw new RiloomError("REVISION_CONFLICT", "工程格式已变化");
      if (change.after === "1.0.0") {
        if (model.assets?.length || model.drawItems?.length)
          throw new RiloomError("INVALID_INPUT", "此工程包含新格式素材");
        delete model.assets;
        delete model.drawItems;
      } else {
        model.assets ??= [];
        model.drawItems ??= [];
      }
      model.formatVersion = change.after;
      inverse.unshift({
        type: "setFormat",
        before: change.after,
        after: change.before,
      });
      continue;
    }
    const kind = change.type.endsWith("Parameter")
      ? "parameter"
      : change.type.endsWith("Asset")
        ? "asset"
        : "drawing";
    if (kind !== "parameter" && model.formatVersion !== "1.1.0")
      throw new RiloomError("INVALID_INPUT", "请先更新工程格式");
    const collection: (Parameter | Asset | DrawItem)[] =
      kind === "parameter"
        ? model.parameters
        : kind === "asset"
          ? model.assets!
          : model.drawItems!;
    if (
      change.type === "addParameter" ||
      change.type === "addAsset" ||
      change.type === "addDrawItem"
    ) {
      if (collection.some((item) => item.id === change.after.id))
        throw new RiloomError("REVISION_CONFLICT", "该对象已经存在");
      const index = change.index ?? collection.length;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > collection.length
      )
        throw new RiloomError("INVALID_INPUT", "对象插入位置无效");
      collection.splice(index, 0, structuredClone(change.after));
      if (change.type === "addParameter")
        inverse.unshift({ type: "removeParameter", before: change.after });
      else if (change.type === "addAsset")
        inverse.unshift({ type: "removeAsset", before: change.after });
      else inverse.unshift({ type: "removeDrawItem", before: change.after });
      continue;
    }
    const index = collection.findIndex((item) => item.id === change.before.id);
    if (
      index < 0 ||
      canonicalJson(collection[index]) !== canonicalJson(change.before)
    )
      throw new RiloomError(
        "REVISION_CONFLICT",
        kind === "parameter"
          ? "参数已被修改，请读取当前值"
          : "对象已被修改，请读取当前值",
      );
    if (
      change.type === "removeParameter" ||
      change.type === "removeAsset" ||
      change.type === "removeDrawItem"
    ) {
      collection.splice(index, 1);
      if (change.type === "removeParameter")
        inverse.unshift({ type: "addParameter", after: change.before, index });
      else if (change.type === "removeAsset")
        inverse.unshift({ type: "addAsset", after: change.before, index });
      else
        inverse.unshift({ type: "addDrawItem", after: change.before, index });
    } else {
      if (change.after.id !== change.before.id)
        throw new RiloomError("INVALID_INPUT", "修改对象时必须保留标识");
      collection[index] = structuredClone(change.after);
      if (change.type === "updateParameter")
        inverse.unshift({
          type: "updateParameter",
          before: change.after,
          after: change.before,
        });
      else
        inverse.unshift({
          type: "updateDrawItem",
          before: change.after,
          after: change.before,
        });
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

export function modelBlobs(model: ProjectModel): BlobRef[] {
  return (model.assets ?? []).flatMap((asset) => [asset.source, asset.pixels]);
}
export function changeBlobs(changes: Change[]): BlobRef[] {
  return changes.flatMap((change) =>
    change.type === "addAsset"
      ? [change.after.source, change.after.pixels]
      : change.type === "removeAsset"
        ? [change.before.source, change.before.pixels]
        : [],
  );
}
export function orderedDrawItems(items: readonly DrawItem[]): DrawItem[] {
  return [...items].sort(
    (a, b) =>
      a.drawOrder - b.drawOrder ||
      (a.orderToken < b.orderToken ? -1 : a.orderToken > b.orderToken ? 1 : 0),
  );
}
