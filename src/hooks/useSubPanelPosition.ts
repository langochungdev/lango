// Tính toán vị trí sub-panel bên cạnh popover, không overlay lên popover
import { useCallback, useEffect, useRef, useState } from "react";
import type { SelectionAnchor } from "@/types/selectionAnchor";

interface PanelPosition {
  left: number;
  top: number;
  maxHeight: number;
}

interface Candidate {
  placement: string;
  left: number;
  top: number;
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MARGIN = 8;
const GAP = 8;
const POINT_PADDING_X = 16;
const POINT_PADDING_Y = 14;

function getCandidates(
  mainRect: DOMRect,
  pw: number,
  ph: number,
  gap: number,
): Candidate[] {
  return [
    { placement: "right-top", left: mainRect.right + gap, top: mainRect.top },
    {
      placement: "right-center",
      left: mainRect.right + gap,
      top: mainRect.top + mainRect.height / 2 - ph / 2,
    },
    {
      placement: "right-bottom",
      left: mainRect.right + gap,
      top: mainRect.bottom - ph,
    },
    {
      placement: "left-top",
      left: mainRect.left - pw - gap,
      top: mainRect.top,
    },
    {
      placement: "left-center",
      left: mainRect.left - pw - gap,
      top: mainRect.top + mainRect.height / 2 - ph / 2,
    },
    {
      placement: "left-bottom",
      left: mainRect.left - pw - gap,
      top: mainRect.bottom - ph,
    },
    {
      placement: "bottom-left",
      left: mainRect.left,
      top: mainRect.bottom + gap,
    },
    {
      placement: "bottom-center",
      left: mainRect.left + mainRect.width / 2 - pw / 2,
      top: mainRect.bottom + gap,
    },
    {
      placement: "bottom-right",
      left: mainRect.right - pw,
      top: mainRect.bottom + gap,
    },
    {
      placement: "top-left",
      left: mainRect.left,
      top: mainRect.top - ph - gap,
    },
    {
      placement: "top-center",
      left: mainRect.left + mainRect.width / 2 - pw / 2,
      top: mainRect.top - ph - gap,
    },
    {
      placement: "top-right",
      left: mainRect.right - pw,
      top: mainRect.top - ph - gap,
    },
  ];
}

function calcOverflow(
  left: number,
  top: number,
  pw: number,
  ph: number,
  margin: number,
  vw: number,
  vh: number,
): number {
  return (
    Math.max(0, margin - left) +
    Math.max(0, margin - top) +
    Math.max(0, left + pw + margin - vw) +
    Math.max(0, top + ph + margin - vh)
  );
}

function overlapArea(rectA: RectLike, rectB: RectLike): number {
  const overlapW = Math.max(
    0,
    Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left),
  );
  const overlapH = Math.max(
    0,
    Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top),
  );
  return overlapW * overlapH;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(val, max));
}

function toRect(
  left: number,
  top: number,
  width: number,
  height: number,
): RectLike {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}

function getWindowOffset(): { x: number; y: number } {
  const x = Number(window.screenX ?? window.screenLeft ?? 0);
  const y = Number(window.screenY ?? window.screenTop ?? 0);
  return { x, y };
}

function toViewportAvoidRect(anchor: SelectionAnchor | null): RectLike | null {
  if (!anchor) {
    return null;
  }

  const offset = getWindowOffset();

  if (anchor.rect) {
    const left = Math.min(anchor.rect.left, anchor.rect.right) - offset.x;
    const top = Math.min(anchor.rect.top, anchor.rect.bottom) - offset.y;
    const right = Math.max(anchor.rect.left, anchor.rect.right) - offset.x;
    const bottom = Math.max(anchor.rect.top, anchor.rect.bottom) - offset.y;
    return { left, top, right, bottom };
  }

  if (anchor.point) {
    const cx = anchor.point.x - offset.x;
    const cy = anchor.point.y - offset.y;
    return {
      left: cx - POINT_PADDING_X,
      top: cy - POINT_PADDING_Y,
      right: cx + POINT_PADDING_X,
      bottom: cy + POINT_PADDING_Y,
    };
  }

  return null;
}

function computePosition(
  popover: HTMLElement,
  panel: HTMLElement,
  selectionAnchor: SelectionAnchor | null,
): PanelPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mainRect = popover.getBoundingClientRect();
  const pw = panel.offsetWidth || 320;
  const ph = panel.offsetHeight || 260;
  const popoverRect = toRect(
    mainRect.left,
    mainRect.top,
    mainRect.width,
    mainRect.height,
  );
  const avoidRect = toViewportAvoidRect(selectionAnchor);
  const candidates = getCandidates(mainRect, pw, ph, GAP);

  const maxX = Math.max(MARGIN, vw - pw - MARGIN);
  const maxY = Math.max(MARGIN, vh - ph - MARGIN);

  let best: {
    left: number;
    top: number;
    score: number;
    placement: string;
  } | null = null;
  for (const c of candidates) {
    const left = clamp(c.left, MARGIN, maxX);
    const top = clamp(c.top, MARGIN, maxY);
    const overflow = calcOverflow(c.left, c.top, pw, ph, MARGIN, vw, vh);
    const panelRect = toRect(left, top, pw, ph);
    const popoverOverlap = overlapArea(panelRect, popoverRect);
    const selectionOverlap = avoidRect ? overlapArea(panelRect, avoidRect) : 0;
    const centerX = left + pw / 2;
    const centerY = top + ph / 2;
    const popCenterX = mainRect.left + mainRect.width / 2;
    const popCenterY = mainRect.top + mainRect.height / 2;
    const distance =
      Math.abs(centerX - popCenterX) + Math.abs(centerY - popCenterY);
    const score =
      popoverOverlap * 700000 +
      selectionOverlap * 450000 +
      overflow * 1000 +
      distance;

    if (!best || score < best.score) {
      best = { left, top, score, placement: c.placement };
    }
  }

  const finalLeft = clamp(
    best ? best.left : mainRect.right + GAP,
    MARGIN,
    maxX,
  );
  const finalTop = clamp(best ? best.top : mainRect.top, MARGIN, maxY);
  const maxHeight = Math.max(120, vh - finalTop - MARGIN);

  return { left: finalLeft, top: finalTop, maxHeight };
}

export function useSubPanelPosition(
  popoverRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
  visible: boolean,
  selectionAnchor: SelectionAnchor | null,
): PanelPosition {
  const [position, setPosition] = useState<PanelPosition>({
    left: -9999,
    top: -9999,
    maxHeight: 400,
  });
  const rafRef = useRef(0);
  const frameCountRef = useRef(0);

  const update = useCallback(() => {
    const popover = popoverRef.current;
    const panel = panelRef.current;
    if (!popover || !panel) return;
    setPosition(computePosition(popover, panel, selectionAnchor));
  }, [popoverRef, panelRef, selectionAnchor]);

  useEffect(() => {
    if (!visible) {
      frameCountRef.current = 0;
      return;
    }

    const scheduleFrame = () => {
      rafRef.current = requestAnimationFrame(() => {
        update();
        frameCountRef.current += 1;
        if (frameCountRef.current < 5) {
          scheduleFrame();
        }
      });
    };

    frameCountRef.current = 0;
    const delayId = setTimeout(() => scheduleFrame(), 50);

    const onResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    };

    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(delayId);
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [visible, update]);

  return position;
}
