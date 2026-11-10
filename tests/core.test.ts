import { describe, expect, it } from "vitest";
import { applyChanges } from "../packages/core/dist/index.js";
import {
  validateRequest,
  type ProjectModel,
} from "../packages/contracts/dist/index.js";
import { parameter, request } from "./helpers.js";

const model = (): ProjectModel => ({
  projectId: "sample",
  formatVersion: "1.0.0",
  name: "测试",
  canvas: { width: 100, height: 100 },
  parameters: ["a", "b", "c"].map((id) => parameter(id)),
});
describe("parameter operations", () => {
  it("restores values and insertion order through inverse changes", () => {
    const source = model();
    const changed = applyChanges(source, [
      { type: "removeParameter", before: source.parameters[1]! },
      {
        type: "updateParameter",
        before: source.parameters[0]!,
        after: { ...source.parameters[0]!, value: 12 },
      },
      { type: "addParameter", after: parameter("d") },
    ]);
    expect(changed.model.parameters.map((item) => item.id)).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(applyChanges(changed.model, changed.inverse).model).toEqual(source);
    expect(source.parameters.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
  it("rejects stale values, invalid ranges, nonfinite values and empty effects", () => {
    const source = model();
    expect(() =>
      applyChanges(source, [
        {
          type: "removeParameter",
          before: { ...source.parameters[0]!, value: 1 },
        },
      ]),
    ).toThrow("参数已被修改");
    for (const invalid of [
      { min: 40 },
      { value: NaN },
      { default: 31 },
      { name: " " },
    ]) {
      expect(() =>
        applyChanges(source, [
          { type: "addParameter", after: { ...parameter("new"), ...invalid } },
        ]),
      ).toThrow();
    }
    expect(() => applyChanges(source, [])).toThrow("没有可应用");
  });
  it("rejects unknown fields and nonfinite command input", () => {
    const input = request(
      "riloom.project.saveDraft",
      {
        draftId: "draft",
        editorId: "editor",
        baseRevision: 0,
        baseStateHash: { algorithm: "sha256", digest: "0".repeat(64) },
        editGeneration: 1,
        changes: [{ type: "addParameter", after: parameter() }],
      },
      { projectId: "sample", expectedDraftVersion: 0 },
    );
    expect(validateRequest(input)).toBe(input);
    expect(() => validateRequest({ ...input, unexpected: true })).toThrow(
      "输入不符合",
    );
    expect(() =>
      validateRequest({
        ...input,
        arguments: {
          ...input.arguments,
          changes: [
            {
              type: "addParameter",
              after: { ...parameter(), value: Infinity },
            },
          ],
        },
      }),
    ).toThrow("输入不符合");
  });
});
