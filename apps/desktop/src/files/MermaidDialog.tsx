import { useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Dialog, PanZoom, ZoomBar, clampZoom, stepZoom, zoomAt, type PanZoomState } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";

// The SVG is mermaid's output and may hold links; like the preview, none of them navigates the WebView.
const blockLinks = (e: MouseEvent<HTMLElement>): void => {
  const target = e.target as { closest?: (selector: string) => unknown } | null;
  if (target?.closest?.("a")) e.preventDefault();
};

/** A diagram at full size inside a dialog, with pan and zoom. `svg` is mermaid's own output (strict level). */
export function MermaidDialog(props: { svg: string; onClose: () => void }): JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<PanZoomState>({ zoom: 1, x: 0, y: 0 });
  const step = (dir: 1 | -1) => setView((v) => zoomAt(v, { x: 0, y: 0 }, clampZoom(stepZoom(v.zoom, dir)) / v.zoom));
  return (
    <Dialog title={t("files.preview.mermaid.title")} size="wide" body="plain" confirmLabel={t("files.image.close")} cancelLabel={null} onConfirm={props.onClose} onCancel={props.onClose}>
      <ZoomBar
        zoom={Math.round(view.zoom * 100)}
        onZoomOut={() => step(-1)}
        onFit={() => setView({ zoom: 1, x: 0, y: 0 })}
        onZoomIn={() => step(1)}
        onActual={() => setView({ zoom: 1, x: 0, y: 0 })}
        labels={{ zoomOut: t("files.zoom.out"), zoomIn: t("files.zoom.in"), fit: t("files.zoom.fit"), actual: t("files.zoom.actual"), group: t("files.zoom.group") }}
      />
      <div className="image-stage md-mermaid-stage">
        <PanZoom zoom={view.zoom} x={view.x} y={view.y} onZoom={setView} onPan={(x, y) => setView((v) => ({ ...v, x, y }))} label={t("files.preview.mermaid.title")}>
          <div className="md-mermaid-full" onClick={blockLinks} onAuxClick={blockLinks} dangerouslySetInnerHTML={{ __html: props.svg }} />
        </PanZoom>
      </div>
    </Dialog>
  );
}
