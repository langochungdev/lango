import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionAnchor } from "@/types/selectionAnchor";

type ScreenWithOffsets = Screen & { availLeft?: number; availTop?: number };
type WindowWithOffsets = Window & { screenLeft?: number; screenTop?: number };
type SubPanelSide = "right" | "left" | "bottom" | "top";

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ScreenBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const BASE_WIDTH = 360;
const BASE_HEIGHT = 180;
const SUBPANEL_DETAIL_WIDTH = 440;
const SUBPANEL_IMAGE_WIDTH = 520;
const SUBPANEL_DETAIL_HEIGHT = 300;
const SUBPANEL_IMAGE_HEIGHT = 360;
const BASE_INSET_X = 12;
const BASE_INSET_Y = 12;
const GAP = 8;
const WINDOW_PADDING_X = 24;
const WINDOW_PADDING_Y = 32;
const SETTLE_FRAMES = 6;

function toRect(
  left: number,
  top: number,
  width: number,
  height: number,
): RectLike {
  return { left, top, right: left + width, bottom: top + height };
}

function overlapArea(a: RectLike, b: RectLike): number {
  const overlapW = Math.max(
    0,
    Math.min(a.right, b.right) - Math.max(a.left, b.left),
  );
  const overlapH = Math.max(
    0,
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  );
  return overlapW * overlapH;
}

function centerDistance(a: RectLike, b: RectLike): number {
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const bx = (b.left + b.right) / 2;
  const by = (b.top + b.bottom) / 2;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function overflowAgainstBounds(rect: RectLike, bounds: ScreenBounds): number {
  return (
    Math.max(0, bounds.left - rect.left) +
    Math.max(0, bounds.top - rect.top) +
    Math.max(0, rect.right - bounds.right) +
    Math.max(0, rect.bottom - bounds.bottom)
  );
}

function getWindowOffset(): { x: number; y: number } {
  const windowWithOffsets = window as WindowWithOffsets;
  return {
    x: Number(window.screenX ?? windowWithOffsets.screenLeft ?? 0),
    y: Number(window.screenY ?? windowWithOffsets.screenTop ?? 0),
  };
}

function getScreenBounds(): ScreenBounds {
  const screen = window.screen as ScreenWithOffsets;
  const left = Number(screen.availLeft ?? 0);
  const top = Number(screen.availTop ?? 0);
  const width = Number(screen.availWidth ?? screen.width ?? window.innerWidth);
  const height = Number(
    screen.availHeight ?? screen.height ?? window.innerHeight,
  );
  return { left, top, right: left + width, bottom: top + height };
}

function toSelectionRect(anchor: SelectionAnchor | null): RectLike | null {
  if (!anchor) {
    return null;
  }
  if (anchor.rect) {
    return {
      left: Math.min(anchor.rect.left, anchor.rect.right),
      top: Math.min(anchor.rect.top, anchor.rect.bottom),
      right: Math.max(anchor.rect.left, anchor.rect.right),
      bottom: Math.max(anchor.rect.top, anchor.rect.bottom),
    };
  }
  if (anchor.point) {
    return toRect(anchor.point.x - 16, anchor.point.y - 14, 32, 28);
  }
  return null;
}

function getAnchorKey(anchor: SelectionAnchor | null): string {
  if (!anchor) {
    return "none";
  }
  if (anchor.rect) {
    const left = Math.min(anchor.rect.left, anchor.rect.right);
    const top = Math.min(anchor.rect.top, anchor.rect.bottom);
    const right = Math.max(anchor.rect.left, anchor.rect.right);
    const bottom = Math.max(anchor.rect.top, anchor.rect.bottom);
    return `rect:${left}:${top}:${right}:${bottom}`;
  }
  if (anchor.point) {
    return `point:${anchor.point.x}:${anchor.point.y}`;
  }
  return "empty";
}

function getSubPanelFallbackSize(panelMode: string): {
  width: number;
  height: number;
} {
  return panelMode === "images"
    ? { width: SUBPANEL_IMAGE_WIDTH, height: SUBPANEL_IMAGE_HEIGHT }
    : { width: SUBPANEL_DETAIL_WIDTH, height: SUBPANEL_DETAIL_HEIGHT };
}

function getRenderedSubPanelSize(
  panelMode: string,
): { width: number; height: number } | null {
  const panel = document.querySelector(
    `.apl-subpanel[data-panel-mode='${panelMode}']`,
  );
  if (
    !(panel instanceof HTMLElement) ||
    panel.offsetWidth <= 0 ||
    panel.offsetHeight <= 0
  ) {
    return null;
  }
  return { width: panel.offsetWidth, height: panel.offsetHeight };
}

function buildPanelRectForSide(
  side: SubPanelSide,
  popoverRect: RectLike,
  panelWidth: number,
  panelHeight: number,
): RectLike {
  const popoverWidth = popoverRect.right - popoverRect.left;
  const popoverHeight = popoverRect.bottom - popoverRect.top;
  if (side === "left") {
    return toRect(
      popoverRect.left - panelWidth - GAP,
      popoverRect.top + (popoverHeight - panelHeight) / 2,
      panelWidth,
      panelHeight,
    );
  }
  if (side === "top") {
    return toRect(
      popoverRect.left + (popoverWidth - panelWidth) / 2,
      popoverRect.top - panelHeight - GAP,
      panelWidth,
      panelHeight,
    );
  }
  if (side === "bottom") {
    return toRect(
      popoverRect.left + (popoverWidth - panelWidth) / 2,
      popoverRect.bottom + GAP,
      panelWidth,
      panelHeight,
    );
  }
  return toRect(
    popoverRect.right + GAP,
    popoverRect.top + (popoverHeight - panelHeight) / 2,
    panelWidth,
    panelHeight,
  );
}

function chooseSubPanelSide(
  popoverRect: RectLike,
  panelWidth: number,
  panelHeight: number,
  bounds: ScreenBounds,
  selectionRect: RectLike | null,
): SubPanelSide {
  const sides: SubPanelSide[] = ["right", "left", "bottom", "top"];
  let bestSide: SubPanelSide = "right";
  let bestScore = Number.POSITIVE_INFINITY;

  for (const side of sides) {
    const panelRect = buildPanelRectForSide(
      side,
      popoverRect,
      panelWidth,
      panelHeight,
    );
    const overflow = overflowAgainstBounds(panelRect, bounds);
    const overlapWithPopover = overlapArea(panelRect, popoverRect);
    const overlapWithSelection = selectionRect
      ? overlapArea(panelRect, selectionRect)
      : 0;
    const primaryDistance = selectionRect
      ? centerDistance(panelRect, selectionRect)
      : centerDistance(panelRect, popoverRect);
    const score =
      overflow * 1_000_000_000 +
      overlapWithPopover * 1_000_000 +
      overlapWithSelection * 10_000 +
      primaryDistance;
    if (score < bestScore) {
      bestScore = score;
      bestSide = side;
    }
  }

  return bestSide;
}

export function usePopoverResize(
  popoverRef: React.RefObject<HTMLElement | null>,
  hasSubPanel: boolean,
  panelMode: string,
  lockedPopoverWidth: number | null,
  selectionAnchor: SelectionAnchor | null,
) {
  const insetRef = useRef({ x: BASE_INSET_X, y: BASE_INSET_Y });
  const resizedRef = useRef(false);
  const lastWindowSizeRef = useRef({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const lastAnchorKeyRef = useRef("none");
  const rafRef = useRef(0);

  useEffect(() => {
    const anchorKey = getAnchorKey(selectionAnchor);
    if (anchorKey !== lastAnchorKeyRef.current) {
      insetRef.current = { x: BASE_INSET_X, y: BASE_INSET_Y };
      resizedRef.current = false;
      lastAnchorKeyRef.current = anchorKey;
    }

    const runLayout = () => {
      const popover = popoverRef.current;
      const previousInset = insetRef.current;
      let insetX = BASE_INSET_X;
      let insetY = BASE_INSET_Y;

      if (!hasSubPanel) {
        if (popover) {
          popover.style.removeProperty("width");
          popover.style.removeProperty("max-width");
          popover.style.left = `${BASE_INSET_X}px`;
          popover.style.top = `${BASE_INSET_Y}px`;
          popover.dataset.subpanelSide = "right";
          delete popover.dataset.subpanelLeft;
          delete popover.dataset.subpanelTop;
        }
        const targetWidth = Math.max(
          120,
          Math.ceil((popover?.offsetWidth ?? BASE_WIDTH) + BASE_INSET_X * 2),
        );
        const targetHeight = Math.max(
          80,
          Math.ceil((popover?.offsetHeight ?? BASE_HEIGHT) + BASE_INSET_Y * 2),
        );
        const sizeChanged =
          targetWidth !== lastWindowSizeRef.current.width ||
          targetHeight !== lastWindowSizeRef.current.height;
        const shiftX = insetX - previousInset.x;
        const shiftY = insetY - previousInset.y;
        if (
          resizedRef.current ||
          sizeChanged ||
          Math.abs(shiftX) > 0.5 ||
          Math.abs(shiftY) > 0.5
        ) {
          resizedRef.current = false;
          lastWindowSizeRef.current = {
            width: targetWidth,
            height: targetHeight,
          };
          void invoke("resize_popover", {
            width: targetWidth,
            height: targetHeight,
            shift_x: shiftX,
            shift_y: shiftY,
          });
        }
        insetRef.current = { x: insetX, y: insetY };
        return;
      }

      const popoverWidth =
        lockedPopoverWidth ?? popover?.offsetWidth ?? BASE_WIDTH;
      const popoverHeight = popover?.offsetHeight ?? BASE_HEIGHT;
      const panelSize =
        getRenderedSubPanelSize(panelMode) ??
        getSubPanelFallbackSize(panelMode);
      const offset = getWindowOffset();
      const screenBounds = getScreenBounds();
      const rawPopoverRect = popover?.getBoundingClientRect();
      const screenPopoverRect = rawPopoverRect
        ? toRect(
            rawPopoverRect.left + offset.x,
            rawPopoverRect.top + offset.y,
            rawPopoverRect.width,
            rawPopoverRect.height,
          )
        : toRect(
            offset.x + insetX,
            offset.y + insetY,
            popoverWidth,
            popoverHeight,
          );
      const selectionRect = toSelectionRect(selectionAnchor);
      const side = chooseSubPanelSide(
        screenPopoverRect,
        panelSize.width,
        panelSize.height,
        screenBounds,
        selectionRect,
      );

      if (side === "left") {
        insetX += panelSize.width + GAP;
      }
      if (side === "top") {
        insetY += panelSize.height + GAP;
      }

      let localPopoverRect = toRect(
        insetX,
        insetY,
        popoverWidth,
        popoverHeight,
      );
      let localPanelRect = buildPanelRectForSide(
        side,
        localPopoverRect,
        panelSize.width,
        panelSize.height,
      );

      if (localPanelRect.left < BASE_INSET_X) {
        const delta = BASE_INSET_X - localPanelRect.left;
        insetX += delta;
        localPopoverRect = toRect(insetX, insetY, popoverWidth, popoverHeight);
        localPanelRect = buildPanelRectForSide(
          side,
          localPopoverRect,
          panelSize.width,
          panelSize.height,
        );
      }
      if (localPanelRect.top < BASE_INSET_Y) {
        const delta = BASE_INSET_Y - localPanelRect.top;
        insetY += delta;
        localPopoverRect = toRect(insetX, insetY, popoverWidth, popoverHeight);
        localPanelRect = buildPanelRectForSide(
          side,
          localPopoverRect,
          panelSize.width,
          panelSize.height,
        );
      }

      if (popover) {
        popover.style.width = `${popoverWidth}px`;
        popover.style.maxWidth = `${popoverWidth}px`;
        popover.style.left = `${insetX}px`;
        popover.style.top = `${insetY}px`;
        popover.dataset.subpanelSide = side;
        popover.dataset.subpanelLeft = `${Math.round(localPanelRect.left)}`;
        popover.dataset.subpanelTop = `${Math.round(localPanelRect.top)}`;
      }

      const contentWidth =
        Math.max(localPopoverRect.right, localPanelRect.right) +
        WINDOW_PADDING_X;
      const contentHeight =
        Math.max(localPopoverRect.bottom, localPanelRect.bottom) +
        WINDOW_PADDING_Y;
      const shiftX = insetX - previousInset.x;
      const shiftY = insetY - previousInset.y;

      resizedRef.current = true;
      insetRef.current = { x: insetX, y: insetY };
      lastWindowSizeRef.current = {
        width: Math.max(BASE_WIDTH, Math.ceil(contentWidth)),
        height: Math.max(BASE_HEIGHT, Math.ceil(contentHeight)),
      };
      void invoke("resize_popover", {
        width: lastWindowSizeRef.current.width,
        height: lastWindowSizeRef.current.height,
        shift_x: shiftX,
        shift_y: shiftY,
      });
    };

    runLayout();
    if (!hasSubPanel) {
      return () => {
        cancelAnimationFrame(rafRef.current);
      };
    }

    let frame = 0;
    const settle = () => {
      rafRef.current = requestAnimationFrame(() => {
        runLayout();
        frame += 1;
        if (frame < SETTLE_FRAMES) {
          settle();
        }
      });
    };
    settle();

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [hasSubPanel, lockedPopoverWidth, panelMode, popoverRef, selectionAnchor]);
}
