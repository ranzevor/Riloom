import { useEffect, useRef, useState } from "react";
import {
  SceneRenderer,
  hitTest,
  type ScenePixels,
  type ViewTransform,
} from "@riloom/renderer";
import type { ProjectModel } from "@riloom/contracts";
import type { Editor } from "./editor.js";

export function Viewport({
  model,
  selected,
  editor,
}: {
  model: ProjectModel;
  selected: string | null;
  editor: Editor;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<SceneRenderer | null>(null);
  const [images, setImages] = useState<ScenePixels>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const error = loadError ?? renderError;
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<ViewTransform | null>(null);
  const scene = useRef({ model, images, zoom });
  scene.current = { model, images, zoom };
  const assetKey = (model.assets ?? [])
    .map((asset) => asset.id + asset.pixels.hash.digest)
    .join(",");
  useEffect(() => {
    let active = true;
    setImages(new Map());
    void Promise.all(
      (model.assets ?? []).map(
        async (asset) =>
          [
            asset.id,
            {
              asset,
              data: await editor.readPixels(asset.pixels, model.projectId),
            },
          ] as const,
      ),
    )
      .then((entries) => {
        if (active) {
          setImages(new Map(entries));
          setLoadError(null);
        }
      })
      .catch((reason) => {
        if (active)
          setLoadError(
            reason instanceof Error ? reason.message : "素材读取失败",
          );
      });
    return () => {
      active = false;
    };
  }, [assetKey, editor, model.projectId]);
  useEffect(() => {
    const element = canvas.current!;
    const draw = () => {
      try {
        renderer.current ??= new SceneRenderer(element);
        const current = scene.current;
        setView(
          renderer.current.draw(current.model, current.images, current.zoom),
        );
        setRenderError(null);
      } catch (reason) {
        setView(null);
        setRenderError(
          reason instanceof Error ? reason.message : "视口初始化失败",
        );
      }
    };
    const lost = (event: Event) => {
      event.preventDefault();
      renderer.current?.dispose();
      renderer.current = null;
      setRenderError("图形上下文已丢失，正在等待恢复");
    };
    const restored = () => {
      draw();
    };
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(draw) : null;
    observer?.observe(element);
    draw();
    return () => {
      observer?.disconnect();
      element.removeEventListener("webglcontextlost", lost);
      element.removeEventListener("webglcontextrestored", restored);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [model.projectId]);
  useEffect(() => {
    if (renderer.current) {
      try {
        setView(renderer.current.draw(model, images, zoom));
        setRenderError(null);
      } catch (reason) {
        setView(null);
        setRenderError(
          reason instanceof Error ? reason.message : "视口绘制失败",
        );
      }
    }
  }, [model, images, zoom]);
  const item = model.drawItems?.find((drawing) => drawing.id === selected);
  const asset = model.assets?.find((source) => source.id === item?.assetId);
  return (
    <div className="viewport-area">
      <div className="viewport-controls">
        <button
          onClick={() => setZoom((value) => Math.max(0.25, value / 1.25))}
          aria-label="缩小视口"
        >
          −
        </button>
        <button onClick={() => setZoom(1)} aria-label="适合画布">
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => setZoom((value) => Math.min(8, value * 1.25))}
          aria-label="放大视口"
        >
          ＋
        </button>
      </div>
      <canvas
        ref={canvas}
        aria-label="模型画布"
        onPointerDown={(event) => {
          if (!view) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const x =
            (((event.clientX - bounds.left) * view.width) / bounds.width -
              view.x) /
            view.scale;
          const y =
            (((event.clientY - bounds.top) * view.height) / bounds.height -
              view.y) /
            view.scale;
          const id = hitTest(model.drawItems ?? [], images, x, y);
          if (id) editor.selectDrawing(id);
        }}
      />
      {view && item && asset && (
        <svg
          className="selection-overlay"
          viewBox={`0 0 ${view.width} ${view.height}`}
          aria-hidden="true"
        >
          <rect
            x={view.x + item.x * view.scale}
            y={view.y + item.y * view.scale}
            width={asset.width * view.scale}
            height={asset.height * view.scale}
          />
        </svg>
      )}
      {error && (
        <p className="viewport-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
