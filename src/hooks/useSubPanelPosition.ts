import { useCallback, useEffect, useRef, useState } from "react";
import { appendDebugLog } from "@/services/debugLog";

interface PanelPosition {
  left: number;
  top: number;
  maxHeight: number;
}

const MARGIN = 8;
const MIN_POPOVER_PANEL_GAP = 18;
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
  const lastClampTraceRef = useRef({ signature: "", at: 0 });

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

    const side = popover.dataset.subpanelSide === "left" ? "left" : "right";
    const popoverRect = popover.getBoundingClientRect();
    const panelWidth = Math.max(
      1,
      Math.ceil(panel.getBoundingClientRect().width || panel.offsetWidth || 0),
    );
    const viewportMinLeft = MARGIN;
    const viewportMaxLeft = Math.max(
      viewportMinLeft,
      window.innerWidth - panelWidth - MARGIN,
    );
    const clampLeft = (value: number) =>
      Math.min(viewportMaxLeft, Math.max(viewportMinLeft, value));

    const leftCandidate = clampLeft(
      popoverRect.left - MIN_POPOVER_PANEL_GAP - panelWidth,
    );
    const rightCandidate = clampLeft(popoverRect.right + MIN_POPOVER_PANEL_GAP);

    const overlapWithPopover = (panelLeft: number) => {
      const panelRight = panelLeft + panelWidth;
      const overlap =
        Math.min(panelRight, popoverRect.right) -
        Math.max(panelLeft, popoverRect.left);
      return Math.max(0, overlap);
    };

    const leftOverlap = overlapWithPopover(leftCandidate);
    const rightOverlap = overlapWithPopover(rightCandidate);

    let chosenSide = side;
    if (side === "left" && leftOverlap > rightOverlap) {
      chosenSide = "right";
    }
    if (side === "right" && rightOverlap > leftOverlap) {
      chosenSide = "left";
    }

    const resolvedLeft = chosenSide === "left" ? leftCandidate : rightCandidate;
    const actualGap =
      chosenSide === "left"
        ? popoverRect.left - (resolvedLeft + panelWidth)
        : resolvedLeft - popoverRect.right;

    if (Math.abs(resolvedLeft - left) > 0.5 || chosenSide !== side) {
      const clampPayload = {
        preferredSide: side,
        chosenSide,
        datasetLeft: left,
        correctedLeft: Math.round(resolvedLeft),
        panelWidth,
        overlap: {
          leftCandidate: Math.round(leftOverlap),
          rightCandidate: Math.round(rightOverlap),
          chosen: Math.max(0, Math.round(-actualGap)),
        },
        gap: {
          min: MIN_POPOVER_PANEL_GAP,
          actual: Math.round(actualGap),
        },
        viewport: {
          minLeft: viewportMinLeft,
          maxLeft: viewportMaxLeft,
          width: window.innerWidth,
        },
        popover: {
          left: Math.round(popoverRect.left),
          right: Math.round(popoverRect.right),
        },
      };
      const signature = JSON.stringify(clampPayload);
      const now = Date.now();
      if (
        signature !== lastClampTraceRef.current.signature ||
        now - lastClampTraceRef.current.at >= 900
      ) {
        appendDebugLog("trace", "Subpanel overlap clamp applied", signature);
        lastClampTraceRef.current = {
          signature,
          at: now,
        };
      }
    }

    const fallbackMaxHeight = Math.max(1, window.innerHeight - top - MARGIN);
    const maxHeight = datasetMaxHeight
      ? Math.max(1, datasetMaxHeight)
      : fallbackMaxHeight;
    setPosition({
      left: resolvedLeft,
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
          "data-subpanel-side",
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
