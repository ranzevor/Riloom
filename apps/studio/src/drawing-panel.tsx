import { useRef } from "react";
import { orderedDrawItems } from "@riloom/core";
import type { Editor, EditorState } from "./editor.js";

export function DrawingPanel({
  editor,
  state,
  busy,
}: {
  editor: Editor;
  state: EditorState;
  busy: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="panel-heading parameter-heading">
        <h2>图层</h2>
        <button
          aria-label="导入 PNG"
          disabled={!state.project || busy || editor.importPending}
          onClick={() => input.current?.click()}
        >
          ＋
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".png,image/png"
        aria-label="PNG 文件"
        className="file-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          if (file.size > 16 * 1024 * 1024) {
            editor.showError(new Error("PNG 文件须在 16 MiB 以内"));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => editor.showError(new Error("文件读取失败"));
          reader.onload = () => {
            void editor.importPng(
              file.name.replace(/\.png$/i, ""),
              String(reader.result).split(",")[1]!,
            );
          };
          reader.readAsDataURL(file);
        }}
      />
      {editor.importPending && (
        <button
          disabled={
            state.loading ||
            state.applying ||
            state.rechecking ||
            state.recovering
          }
          onClick={() => void editor.retryImport()}
        >
          核对导入结果
        </button>
      )}
      <nav aria-label="图层列表">
        {orderedDrawItems(state.drawItems)
          .reverse()
          .map((item) => (
            <div className="layer-row" key={item.id}>
              <button
                aria-label={(item.visible ? "隐藏 " : "显示 ") + item.name}
                disabled={busy}
                onClick={() =>
                  editor.updateDrawing(item.id, { visible: !item.visible })
                }
              >
                {item.visible ? "◉" : "○"}
              </button>
              <button
                className={state.selectedDrawing === item.id ? "selected" : ""}
                onClick={() => editor.selectDrawing(item.id)}
              >
                {item.name}
              </button>
            </div>
          ))}
      </nav>
    </>
  );
}
export function DrawingProperties({
  editor,
  state,
  busy,
}: {
  editor: Editor;
  state: EditorState;
  busy: boolean;
}) {
  const item = state.drawItems.find(
    (drawing) => drawing.id === state.selectedDrawing,
  );
  if (!item) return null;
  const source = state.assets.find((asset) => asset.id === item.assetId);
  return (
    <>
      <div className="panel-heading">
        <h2>图层属性</h2>
      </div>
      <fieldset disabled={busy}>
        <label>
          名称
          <input
            value={item.name}
            maxLength={120}
            onChange={(event) =>
              editor.updateDrawing(item.id, { name: event.target.value })
            }
          />
        </label>
        {(["x", "y"] as const).map((key) => (
          <label key={key}>
            {key === "x" ? "水平位置" : "垂直位置"}
            <input
              type="number"
              step="any"
              value={Number.isFinite(item[key]) ? item[key] : ""}
              onChange={(event) =>
                editor.updateDrawing(item.id, {
                  [key]:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                })
              }
            />
          </label>
        ))}
        <label>
          不透明度
          <input
            aria-label="图层不透明度"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={item.opacity}
            onChange={(event) =>
              editor.updateDrawing(item.id, {
                opacity: Number(event.target.value),
              })
            }
          />
          <output>{Math.round(item.opacity * 100)}%</output>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={item.visible}
            onChange={(event) =>
              editor.updateDrawing(item.id, { visible: event.target.checked })
            }
          />
          显示图层
        </label>
        <p className="hint">
          {source?.width} × {source?.height} · {source?.bitDepth} 位
        </p>
        <div className="layer-order">
          <button onClick={() => editor.moveDrawing(item.id, 1)}>上移</button>
          <button onClick={() => editor.moveDrawing(item.id, -1)}>下移</button>
        </div>
        <button
          className="danger"
          onClick={() => editor.removeDrawing(item.id)}
        >
          删除图层
        </button>
      </fieldset>
    </>
  );
}
