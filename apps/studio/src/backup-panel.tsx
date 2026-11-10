import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Editor } from "./editor.js";

export function BackupPanel({
  editor,
  onClose,
}: {
  editor: Editor;
  onClose(): void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(""),
    [directory, setDirectory] = useState("恢复工程.riloom"),
    [source, setSource] = useState("");
  const busy = state.loading || state.applying || state.rechecking;
  useEffect(() => {
    const element = dialog.current!;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    return () => {
      if (element.open && element.close) element.close();
    };
  }, []);
  useEffect(() => {
    if (!selected && state.backups[0]) {
      setSelected(state.backups[0].backupId);
      setDirectory(state.backups[0].projectName + "-恢复.riloom");
    }
  }, [selected, state.backups]);
  return (
    <dialog
      ref={dialog}
      className="backup-panel"
      aria-labelledby="backup-heading"
      onCancel={(event) => {
        if (busy || state.recovering) event.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="panel-heading">
        <h2 id="backup-heading">备份与恢复</h2>
        <button
          aria-label="关闭备份与恢复"
          onClick={onClose}
          disabled={busy || state.recovering}
        >
          ×
        </button>
      </div>
      <p className="hint">
        备份包含工程、已保存草稿和撤销历史。恢复到新目录后，该目录成为当前工程。
      </p>
      <button
        onClick={() => void editor.backup()}
        disabled={!state.project || busy || state.recovering}
      >
        备份当前工程
      </button>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.backupMessage && (
        <p className="backup-message" role="status">
          {state.backupMessage}
        </p>
      )}
      <div className="backup-list" aria-label="工程备份">
        {state.backups.length === 0 && (
          <p className="hint">创建工程备份，或导入已有备份目录。</p>
        )}
        {state.backups.map((backup) => (
          <button
            key={backup.backupId}
            className={selected === backup.backupId ? "selected" : ""}
            disabled={busy || state.recovering}
            onClick={() => {
              setSelected(backup.backupId);
              setDirectory(backup.projectName + "-恢复.riloom");
            }}
          >
            <strong>{backup.projectName}</strong>
            <span>
              {new Date(backup.createdAt).toLocaleString()} ·{" "}
              {Math.ceil(backup.bytes / 1024)} KB
            </span>
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void editor.restoreBackup(selected, directory);
        }}
      >
        <label>
          恢复后的工程目录
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            required
            maxLength={120}
            disabled={busy || state.recovering}
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !selected}>
          {state.recovering ? "核对恢复结果" : "恢复选定备份"}
        </button>
      </form>
      <details>
        <summary>导入已有备份</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void editor.importBackup(source);
          }}
        >
          <label>
            备份目录
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              required
              disabled={busy || state.recovering}
            />
          </label>
          <button type="submit" disabled={busy || state.recovering}>
            导入备份
          </button>
        </form>
      </details>
    </dialog>
  );
}
