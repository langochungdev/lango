import { useCallback, useEffect, useState } from "react";

interface PanelPosition {
  left: number;
  top: number;
  maxHeight: number;
}

const MARGIN = 8;
const HIDDEN_POSITION: PanelPosition = {
  left: -9999,
  top: -9999,
  maxHeight: 400,
};

function readDatasetNumber(
  el: HTMLElement,
  key: "subpanelLeft" | "subpanelTop" | "subpanelMaxHeight",
): number | null {
  const raw = el.dataset[key];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function useSubPanelPosition(
  popoverRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
  visible: boolean,
): PanelPosition {
  const [position, setPosition] = useState<PanelPosition>(HIDDEN_POSITION);

  const update = useCallback(() => {
    const popover = popoverRef.current;
    const panel = panelRef.current;
    if (!popover || !panel) {
      setPosition(HIDDEN_POSITION);
      return;
    }

    const left = readDatasetNumber(popover, "subpanelLeft");
    const top = readDatasetNumber(popover, "subpanelTop");
    const datasetMaxHeight = readDatasetNumber(popover, "subpanelMaxHeight");
    if (left === null || top === null) {
      setPosition(HIDDEN_POSITION);
      return;
    }

    const fallbackMaxHeight = Math.max(1, window.innerHeight - top - MARGIN);
    const maxHeight = datasetMaxHeight
      ? Math.max(1, datasetMaxHeight)
      : fallbackMaxHeight;
    setPosition({
      left,
      top,
      maxHeight,
    });
  }, [panelRef, popoverRef]);

  useEffect(() => {
    if (!visible) {
      setPosition(HIDDEN_POSITION);
      return;
    }

    let frame = 0;
    let rafId = 0;

    const scheduleFrame = () => {
      rafId = requestAnimationFrame(() => {
        update();
        frame += 1;
        if (frame < 6) {
          scheduleFrame();
        }
      });
    };

    scheduleFrame();

    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    };

    const popover = popoverRef.current;
    const observer = popover
      ? new MutationObserver(() => {
          cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(update);
        })
      : null;

    if (observer && popover) {
      observer.observe(popover, {
        attributes: true,
        attributeFilter: [
          "data-subpanel-left",
          "data-subpanel-top",
          "data-subpanel-max-height",
        ],
      });
    }

    window.addEventListener("resize", onResize);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
    };
  }, [popoverRef, visible, update]);

  return position;
}
