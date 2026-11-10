import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  RiloomError,
  type CommandRequest,
  type Receipt,
} from "@riloom/contracts";
import { Editor } from "./editor.js";
import { Viewport } from "./viewport.js";
import { DrawingPanel, DrawingProperties } from "./drawing-panel.js";
import { BackupPanel } from "./backup-panel.js";
import "./style.css";

function Workbench({ editor }: { editor: Editor }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [showBackups, setShowBackups] = useState(false);
  const [creating, setCreating] = useState(false),
    [name, setName] = useState("新工程"),
    [directory, setDirectory] = useState("新工程.riloom");
  const parameter = state.parameters.find((item) => item.id === state.selected);
  const changes = editor.changes(),
    busy =
      state.loading ||
      state.applying ||
      state.rechecking ||
      state.recovering ||
      editor.importPending;
  useEffect(() => {
    void editor.initialize().catch((error) => editor.showError(error));
    const focus = () => {
      void editor.refreshCurrent();
    };
    const unload = (event: BeforeUnloadEvent) => {
      const current = editor.getSnapshot();
      if (
        current.generation > current.savedGeneration ||
        current.applying ||
        current.recovering
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void editor.save();
      }
    };
    window.addEventListener("focus", focus);
    window.addEventListener("beforeunload", unload);
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("keydown", keys);
      editor.dispose();
    };
  }, [editor]);
  useEffect(() => {
    if (!state.project) return;
    const source = new EventSource(
      "/api/v1/events?projectId=" +
        encodeURIComponent(state.project.model.projectId) +
        "&after=" +
        state.project.eventCursor,
    );
    source.onmessage = () => {
      void editor.refreshCurrent();
    };
    return () => source.close();
  }, [
    editor,
    state.project?.model.projectId,
    state.project?.storageGeneration,
  ]);
  const status = state.applying
    ? "正在应用"
    : state.saving
      ? "正在保存草稿"
      : state.generation > state.savedGeneration
        ? "有未保存的修改"
        : changes.length
          ? "草稿已保存，待应用"
          : "工程已保存";
  return (
    <div className="studio">
      <header>
        <div className="brand">
          R
          <span>
            Riloom <small>Studio</small>
          </span>
        </div>
        <span className="project-name">
          {state.project?.model.name ?? "选择工作区工程"}
        </span>
        <span className="save-state" role="status">
          {state.project ? status : "开始新的制作"}
        </span>
        <div className="header-actions">
          <button
            onClick={() => {
              setShowBackups(true);
              void editor
                .refreshBackups()
                .catch((error) => editor.showError(error));
            }}
            disabled={busy}
          >
            备份与恢复
          </button>
          <button
            onClick={() => void editor.navigate("undo")}
            disabled={busy || !!changes.length || !state.project?.undoGroupId}
          >
            撤销
          </button>
          <button
            onClick={() => void editor.navigate("redo")}
            disabled={busy || !!changes.length || !state.project?.redoGroupId}
          >
            重做
          </button>
          <button
            onClick={() => void editor.save()}
            disabled={
              busy || state.saving || state.generation === state.savedGeneration
            }
          >
            保存草稿
          </button>
          <button
            className="primary"
            onClick={() => void editor.apply()}
            disabled={
              state.loading ||
              editor.importPending ||
              state.applying ||
              (!changes.length && !state.rechecking)
            }
          >
            {state.rechecking ? "核对应用结果" : "应用草稿"}
          </button>
        </div>
      </header>
      {showBackups && (
        <BackupPanel editor={editor} onClose={() => setShowBackups(false)} />
      )}
      <aside className="projects">
        <div className="panel-heading">
          <h2>工程</h2>
          <button
            aria-label="新建工程"
            onClick={() => setCreating(true)}
            disabled={busy}
          >
            ＋
          </button>
        </div>
        {creating && (
          <form
            className="create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void editor.create(name, directory).then(() => {
                if (!editor.getSnapshot().error) setCreating(false);
              });
            }}
          >
            <label>
              工程名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
                disabled={busy}
              />
            </label>
            <label>
              工程目录
              <input
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            <div>
              <button className="primary" type="submit" disabled={busy}>
                创建工程
              </button>
              <button type="button" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </form>
        )}
        <nav aria-label="工程列表">
          {state.projects.map((project) => (
            <button
              key={project.projectId}
              className={
                project.projectId === state.project?.model.projectId
                  ? "selected"
                  : ""
              }
              onClick={() => void editor.open(project.projectId)}
              disabled={busy}
            >
              {project.name}
              <span>工程</span>
            </button>
          ))}
        </nav>
        <DrawingPanel editor={editor} state={state} busy={busy} />
        <div className="panel-heading parameter-heading">
          <h2>参数</h2>
          <button
            aria-label="添加参数"
            disabled={!state.project || busy}
            onClick={() => editor.addParameter()}
          >
            ＋
          </button>
        </div>
        <nav aria-label="参数列表">
          {state.parameters.map((item) => (
            <button
              key={item.id}
              className={item.id === state.selected ? "selected" : ""}
              onClick={() => editor.select(item.id)}
            >
              {item.name}
              <span>{item.value}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main>
        {state.error && !showBackups && (
          <div className="error" role="alert">
            <span>{state.error}</span>
            {state.project && (
              <button onClick={() => void editor.rebase()} disabled={busy}>
                保留编辑并重新准备
              </button>
            )}
          </div>
        )}
        <div className="canvas-toolbar">
          <span>{state.project ? "模型制作" : "工作区"}</span>
          <span>
            {state.project
              ? state.project.model.canvas.width +
                " × " +
                state.project.model.canvas.height
              : "Riloom"}
          </span>
        </div>
        <section className="canvas" aria-label="工程工作区">
          {state.project && state.assets.length ? (
            <Viewport
              key={state.project.model.projectId}
              model={{
                ...state.project.model,
                formatVersion: "1.1.0",
                parameters: state.parameters,
                assets: state.assets,
                drawItems: state.drawItems,
              }}
              selected={state.selectedDrawing}
              editor={editor}
            />
          ) : state.project ? (
            <div className="parameter-card">
              <span className="eyebrow">PARAMETER</span>
              <h1>{parameter?.name ?? state.project.model.name}</h1>
              <p>
                {parameter
                  ? "调整右侧属性，草稿将自动保存。"
                  : "添加参数，开始编辑工程。"}
              </p>
              {parameter && (
                <>
                  <output>
                    {Number.isFinite(parameter.value) ? parameter.value : "—"}
                  </output>
                  <input
                    aria-label="参数值"
                    type="range"
                    min={parameter.min}
                    max={parameter.max}
                    step="any"
                    value={
                      Number.isFinite(parameter.value) ? parameter.value : 0
                    }
                    disabled={busy}
                    onChange={(event) =>
                      editor.updateParameter(parameter.id, {
                        value: Number(event.target.value),
                      })
                    }
                  />
                  <div className="range-labels">
                    <span>{parameter.min}</span>
                    <span>{parameter.max}</span>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="welcome">
              <span className="eyebrow">YOUR NEXT CHARACTER</span>
              <h1>从一个工程开始</h1>
              <p>创建工程，组织参数，让每一次修改都可保存、可撤销。</p>
              <button className="primary" onClick={() => setCreating(true)}>
                新建工程
              </button>
            </div>
          )}
        </section>
        <footer>
          <span>
            {state.drawItems.length} 个图层 · {state.parameters.length} 个参数
          </span>
          <details>
            <summary>
              查看更改{changes.length ? " · " + changes.length : ""}
            </summary>
            <ul>
              {changes.map((change, index) => (
                <li key={index}>
                  {change.type === "addParameter"
                    ? "新增 " + change.after.name
                    : change.type === "removeParameter"
                      ? "删除 " + change.before.name
                      : change.type === "setFormat"
                        ? "更新工程格式"
                        : "修改 " +
                          ("after" in change
                            ? change.after.name
                            : change.before.name)}
                </li>
              ))}
            </ul>
          </details>
        </footer>
      </main>
      <aside className="properties">
        {state.selectedDrawing ? (
          <DrawingProperties editor={editor} state={state} busy={busy} />
        ) : (
          <>
            <div className="panel-heading">
              <h2>参数属性</h2>
            </div>
            {parameter ? (
              <fieldset disabled={busy}>
                <label>
                  名称
                  <input
                    value={parameter.name}
                    maxLength={120}
                    onChange={(event) =>
                      editor.updateParameter(parameter.id, {
                        name: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  单位
                  <input
                    value={parameter.unit}
                    maxLength={32}
                    onChange={(event) =>
                      editor.updateParameter(parameter.id, {
                        unit: event.target.value,
                      })
                    }
                  />
                </label>
                {(
                  [
                    ["min", "最小值"],
                    ["default", "默认值"],
                    ["max", "最大值"],
                    ["value", "当前值"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      step="any"
                      value={
                        Number.isFinite(parameter[key]) ? parameter[key] : ""
                      }
                      onChange={(event) =>
                        editor.updateParameter(parameter.id, {
                          [key]:
                            event.target.value === ""
                              ? NaN
                              : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                ))}
                <button
                  className="danger"
                  onClick={() => editor.removeParameter(parameter.id)}
                >
                  删除参数
                </button>
              </fieldset>
            ) : (
              <p className="hint">选择图层或参数以编辑属性。</p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
async function start() {
  const token = window.location.hash.slice(1);
  history.replaceState(null, "", location.pathname + location.search);
  const sessionResponse = token
    ? await fetch("/api/v1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
    : await fetch("/api/v1/session");
  if (!sessionResponse.ok) throw new Error("请重新打开工作区的启动链接。");
  const session = (await sessionResponse.json()) as {
    workspaceId: string;
    csrf: string;
  };
  const execute = async (request: CommandRequest): Promise<Receipt> => {
    let response: Response;
    try {
      response = await fetch("/api/v1/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Riloom-CSRF": session.csrf,
        },
        body: JSON.stringify(request),
      });
    } catch {
      throw new RiloomError(
        "EFFECT_UNRESOLVED",
        "连接中断，请重试保存以核对原请求。",
      );
    }
    const result = await response.json();
    if (!response.ok)
      throw new RiloomError(
        result.error.code,
        result.error.message,
        result.error.details,
      );
    return result as Receipt;
  };
  createRoot(document.getElementById("root")!).render(
    <Workbench
      editor={new Editor(execute, session.workspaceId, sessionStorage)}
    />,
  );
}
void start().catch((error) => {
  createRoot(document.getElementById("root")!).render(
    <div className="startup-error">
      <h1>Riloom Studio</h1>
      <p>{error instanceof Error ? error.message : "工作区连接失败"}</p>
    </div>,
  );
});
