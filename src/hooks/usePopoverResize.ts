import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionAnchor } from "@/types/selectionAnchor";

type ScreenWithOffsets = Screen & { availLeft?: number; availTop?: number };
type WindowWithOffsets = Window & { screenLeft?: number; screenTop?: number };
type SubPanelSide = "right" | "left";

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

const BASE_WIDTH = 420;
const BASE_HEIGHT = 72;
// const MIN_LOOKUP_HEIGHT = 148;
// const MIN_TRANSLATE_HEIGHT = 108;
const SUBPANEL_DETAIL_WIDTH = 440;
const SUBPANEL_IMAGE_WIDTH = 520;
const SUBPANEL_DETAIL_HEIGHT = 300;
const SUBPANEL_IMAGE_HEIGHT = 360;
const BASE_INSET_X = 4;
const BASE_INSET_Y = 4;
const GAP = 8;
const WINDOW_PADDING_X = 18;
const WINDOW_PADDING_Y = 32;
const SETTLE_FRAMES = 6;
const NO_SUBPANEL_SETTLE_FRAMES = 4;
const POST_SHOW_REMEASURE_MS = [90, 180, 320, 480] as const;
const VIEWPORT_OVERFLOW_GUARD_PX = 6;
const MIN_DYNAMIC_WINDOW_GUARD_PX = 2;

function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function buildResizeArgs(params: {
  width: number;
  height: number;
  shiftX?: number;
  shiftY?: number;
  targetX?: number;
  targetY?: number;
  anchor: SelectionAnchor | null;
}) {
  return {
    width: params.width,
    height: params.height,
    shift_x: params.shiftX,
    shift_y: params.shiftY,
    shiftX: params.shiftX,
    shiftY: params.shiftY,
    target_x: params.targetX,
    target_y: params.targetY,
    targetX: params.targetX,
    targetY: params.targetY,
    anchor: params.anchor,
  };
}

function toRect(
  left: number,
  top: number,
  width: number,
  height: number,
): RectLike {
  return { left, top, right: left + width, bottom: top + height };
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

function splitShadowLayers(value: string): string[] {
  const layers: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0) {
      const part = value.slice(start, i).trim();
      if (part) {
        layers.push(part);
      }
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) {
    layers.push(tail);
  }
  return layers;
}

function extractPxValues(value: string): number[] {
  const matches = value.match(/-?\d*\.?\d+px/g);
  if (!matches) {
    return [];
  }
  return matches
    .map((item) => Number.parseFloat(item.replace("px", "")))
    .filter((item) => Number.isFinite(item));
}

function readBoxShadowInsets(boxShadow: string): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  if (!boxShadow || boxShadow === "none") {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }

  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;

  const layers = splitShadowLayers(boxShadow);
  for (const layer of layers) {
    if (layer.includes("inset")) {
      continue;
    }
    const values = extractPxValues(layer);
    const offsetX = values[0] ?? 0;
    const offsetY = values[1] ?? 0;
    const blur = Math.max(0, values[2] ?? 0);
    const spread = values[3] ?? 0;
    const extent = Math.max(0, blur + spread);

    left = Math.max(left, Math.max(0, extent - offsetX));
    right = Math.max(right, Math.max(0, extent + offsetX));
    top = Math.max(top, Math.max(0, extent - offsetY));
    bottom = Math.max(bottom, Math.max(0, extent + offsetY));
  }

  return { left, right, top, bottom };
}

function getPopoverWindowInsets(popover: HTMLElement): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const style = window.getComputedStyle(popover);
  const shadowInsets = readBoxShadowInsets(style.boxShadow);
  const adaptiveX = Math.max(
    MIN_DYNAMIC_WINDOW_GUARD_PX,
    Math.ceil((popover.offsetWidth || BASE_WIDTH) * 0.01),
  );
  const adaptiveY = Math.max(
    MIN_DYNAMIC_WINDOW_GUARD_PX,
    Math.ceil((popover.offsetHeight || BASE_HEIGHT) * 0.015),
  );

  return {
    left: Math.max(BASE_INSET_X, Math.ceil(shadowInsets.left) + adaptiveX),
    right: Math.max(BASE_INSET_X, Math.ceil(shadowInsets.right) + adaptiveX),
    top: Math.max(BASE_INSET_Y, Math.ceil(shadowInsets.top) + adaptiveY),
    bottom: Math.max(BASE_INSET_Y, Math.ceil(shadowInsets.bottom) + adaptiveY),
  };
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
  panelTop: number,
): RectLike {
  if (side === "left") {
    return toRect(
      popoverRect.left - panelWidth - GAP,
      panelTop,
      panelWidth,
      panelHeight,
    );
  }
  return toRect(popoverRect.right + GAP, panelTop, panelWidth, panelHeight);
}

function chooseSubPanelSide(
  popoverRect: RectLike,
  bounds: ScreenBounds,
): SubPanelSide {
  const popoverCenterX = (popoverRect.left + popoverRect.right) / 2;
  const screenCenterX = (bounds.left + bounds.right) / 2;
  return popoverCenterX >= screenCenterX ? "left" : "right";
}

export function usePopoverResize(
  popoverRef: React.RefObject<HTMLElement | null>,
  popoverState: string,
  hasSubPanel: boolean,
  panelMode: string,
  lockedPopoverWidth: number | null,
  minPopoverWidth: number,
  stablePopoverWidth: number | null,
  selectionAnchor: SelectionAnchor | null,
) {
  const insetRef = useRef({ x: BASE_INSET_X, y: BASE_INSET_Y });
  const resizedRef = useRef(false);
  const lastWindowSizeRef = useRef({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const lastAnchorKeyRef = useRef("none");
  const stableScreenPopoverRef = useRef<{ x: number; y: number } | null>(null);
  const previewWindowOffsetRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);

  useEffect(() => {
    const canInvoke = hasTauriBridge();

    const anchorKey = getAnchorKey(selectionAnchor);
    if (anchorKey !== lastAnchorKeyRef.current) {
      insetRef.current = { x: BASE_INSET_X, y: BASE_INSET_Y };
      resizedRef.current = false;
      stableScreenPopoverRef.current = null;
      previewWindowOffsetRef.current = { x: 0, y: 0 };
      lastAnchorKeyRef.current = anchorKey;
    }

    const runLayout = () => {
      const popover = popoverRef.current;
      const previewShell = popover?.closest(".apl-popover-shell--preview");
      const previewWindow =
        previewShell instanceof HTMLElement ? previewShell : null;
      const previousInset = insetRef.current;
      let insetX = BASE_INSET_X;
      let insetY = BASE_INSET_Y;

      if (!hasSubPanel) {
        if (!popover) {
          insetRef.current = { x: insetX, y: insetY };
          stableScreenPopoverRef.current = null;
          previewWindowOffsetRef.current = { x: 0, y: 0 };
          return;
        }

        const preferredWidth =
          stablePopoverWidth && stablePopoverWidth > 0
            ? stablePopoverWidth
            : null;
        if (preferredWidth) {
          popover.style.width = `${preferredWidth}px`;
          popover.style.maxWidth = `${preferredWidth}px`;
        } else {
          popover.style.removeProperty("width");
          popover.style.removeProperty("max-width");
        }
        popover.dataset.subpanelSide = "right";
        delete popover.dataset.subpanelLeft;
        delete popover.dataset.subpanelTop;
        delete popover.dataset.subpanelMaxHeight;
        stableScreenPopoverRef.current = null;
        previewWindowOffsetRef.current = { x: 0, y: 0 };

        if (!canInvoke && previewWindow) {
          previewWindow.style.removeProperty("width");
          previewWindow.style.removeProperty("height");
          previewWindow.style.removeProperty("transform");
        }

        const popoverInsets = getPopoverWindowInsets(popover);
        insetX = popoverInsets.left;
        insetY = popoverInsets.top;
        popover.style.left = `${insetX}px`;
        popover.style.top = `${insetY}px`;

        const measuredRect = popover.getBoundingClientRect();
        const measuredWidth = preferredWidth
          ? preferredWidth
          : Math.max(popover.offsetWidth, measuredRect.width);
        const measuredHeight = Math.max(
          popover.scrollHeight,
          popover.offsetHeight,
          measuredRect.height,
        );
        const screenBounds = getScreenBounds();
        const maxWindowHeight = Math.max(
          BASE_HEIGHT,
          Math.floor(
            screenBounds.bottom -
              screenBounds.top -
              popoverInsets.top -
              popoverInsets.bottom,
          ),
        );
        const minAllowedWidth = Math.max(minPopoverWidth, Math.ceil(measuredWidth));
        const measuredTargetWidth = Math.ceil(
          measuredWidth + popoverInsets.left + popoverInsets.right,
        );
        const hasHorizontalOverflow =
          popover.scrollWidth > popover.clientWidth + 1;
        const overflowTargetWidth = Math.ceil(
          Math.max(popover.scrollWidth, measuredRect.width) +
            popoverInsets.left +
            popoverInsets.right,
        );
        const baseTargetWidth = Math.max(minAllowedWidth, measuredTargetWidth);
        const targetWidth = hasHorizontalOverflow
          ? Math.max(baseTargetWidth, overflowTargetWidth)
          : baseTargetWidth;
        const targetHeight = Math.max(
          1,
          Math.min(
            Math.ceil(
              measuredHeight + popoverInsets.top + popoverInsets.bottom,
            ),
            maxWindowHeight,
          ),
        );

        const viewportOverflowX = Math.max(
          0,
          Math.ceil(
            Math.max(
              document.documentElement.scrollWidth,
              document.body?.scrollWidth ?? 0,
            ) - window.innerWidth,
          ),
        );
        const viewportOverflowY = Math.max(
          0,
          Math.ceil(
            Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight ?? 0,
            ) - window.innerHeight,
          ),
        );

        const safeTargetWidth =
          viewportOverflowX > 0
            ? targetWidth + viewportOverflowX + VIEWPORT_OVERFLOW_GUARD_PX
            : targetWidth;
        const safeTargetHeight =
          viewportOverflowY > 0
            ? Math.min(
                maxWindowHeight,
                targetHeight + viewportOverflowY + VIEWPORT_OVERFLOW_GUARD_PX,
              )
            : targetHeight;
        const sizeChanged =
          safeTargetWidth !== lastWindowSizeRef.current.width ||
          safeTargetHeight !== lastWindowSizeRef.current.height;
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
            width: safeTargetWidth,
            height: safeTargetHeight,
          };
          if (canInvoke) {
            void invoke(
              "resize_popover",
              buildResizeArgs({
                width: safeTargetWidth,
                height: safeTargetHeight,
                shiftX,
                shiftY,
                anchor: selectionAnchor,
              }),
            );
          }
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
      if (!stableScreenPopoverRef.current) {
        stableScreenPopoverRef.current = {
          x: screenPopoverRect.left,
          y: screenPopoverRect.top,
        };
      }
      const stableScreenPopover = stableScreenPopoverRef.current;
      const side = chooseSubPanelSide(screenPopoverRect, screenBounds);

      insetY = BASE_INSET_Y;
      insetX =
        side === "left" ? BASE_INSET_X + panelSize.width + GAP : BASE_INSET_X;

      const localPopoverRect = toRect(
        insetX,
        insetY,
        popoverWidth,
        popoverHeight,
      );

      const preferredPanelTop =
        localPopoverRect.top + (popoverHeight - panelSize.height) / 2;
      const panelTop = Math.max(BASE_INSET_Y, preferredPanelTop);

      let localPanelRect = buildPanelRectForSide(
        side,
        localPopoverRect,
        panelSize.width,
        panelSize.height,
        panelTop,
      );

      const windowTopOnScreen = screenPopoverRect.top - insetY;
      const maxWindowHeight = Math.max(
        BASE_HEIGHT,
        Math.floor(screenBounds.bottom - windowTopOnScreen - BASE_INSET_Y),
      );
      const maxPanelHeight = Math.max(
        1,
        Math.floor(maxWindowHeight - localPanelRect.top - WINDOW_PADDING_Y),
      );
      const effectivePanelHeight = Math.min(panelSize.height, maxPanelHeight);
      localPanelRect = toRect(
        localPanelRect.left,
        localPanelRect.top,
        localPanelRect.right - localPanelRect.left,
        effectivePanelHeight,
      );

      if (popover) {
        popover.style.width = `${popoverWidth}px`;
        popover.style.maxWidth = `${popoverWidth}px`;
        popover.style.left = `${insetX}px`;
        popover.style.top = `${insetY}px`;
        popover.dataset.subpanelSide = side;
        popover.dataset.subpanelLeft = `${Math.round(localPanelRect.left)}`;
        popover.dataset.subpanelTop = `${Math.round(localPanelRect.top)}`;
        popover.dataset.subpanelMaxHeight = `${Math.round(effectivePanelHeight)}`;
      }

      const contentWidth =
        Math.max(localPopoverRect.right, localPanelRect.right) +
        WINDOW_PADDING_X;
      const contentHeight =
        Math.max(localPopoverRect.bottom, localPanelRect.bottom) +
        WINDOW_PADDING_Y;
      const projectedScreenPopoverLeft = canInvoke
        ? offset.x + insetX
        : screenPopoverRect.left + (insetX - previousInset.x);
      const projectedScreenPopoverTop = canInvoke
        ? offset.y + insetY
        : screenPopoverRect.top + (insetY - previousInset.y);
      const shiftX = projectedScreenPopoverLeft - stableScreenPopover.x;
      const shiftY = projectedScreenPopoverTop - stableScreenPopover.y;
      const targetWindowX = stableScreenPopover.x - insetX;
      const targetWindowY = stableScreenPopover.y - insetY;

      const nextWindowWidth = Math.max(BASE_WIDTH, Math.ceil(contentWidth));
      const nextWindowHeight = Math.max(
        BASE_HEIGHT,
        Math.min(Math.ceil(contentHeight), maxWindowHeight),
      );
      const sizeChanged =
        nextWindowWidth !== lastWindowSizeRef.current.width ||
        nextWindowHeight !== lastWindowSizeRef.current.height;
      const hadResized = resizedRef.current;

      resizedRef.current = true;
      insetRef.current = { x: insetX, y: insetY };
      lastWindowSizeRef.current = {
        width: nextWindowWidth,
        height: nextWindowHeight,
      };
      if (
        !hadResized ||
        sizeChanged ||
        Math.abs(shiftX) > 0.5 ||
        Math.abs(shiftY) > 0.5
      ) {
        if (canInvoke) {
          void invoke(
            "resize_popover",
            buildResizeArgs({
              width: nextWindowWidth,
              height: nextWindowHeight,
              shiftX,
              shiftY,
              targetX: targetWindowX,
              targetY: targetWindowY,
              anchor: null,
            }),
          );
        } else if (previewWindow) {
          const nextOffsetX = previewWindowOffsetRef.current.x - shiftX;
          const nextOffsetY = previewWindowOffsetRef.current.y - shiftY;
          previewWindowOffsetRef.current = {
            x: nextOffsetX,
            y: nextOffsetY,
          };
          previewWindow.style.width = `${nextWindowWidth}px`;
          previewWindow.style.height = `${nextWindowHeight}px`;
          previewWindow.style.transform = `translate(${Math.round(nextOffsetX)}px, ${Math.round(nextOffsetY)}px)`;
        }
      }
    };

    const scheduleLayout = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        runLayout();
      });
    };

    const timers: number[] = [];
    for (const delay of POST_SHOW_REMEASURE_MS) {
      timers.push(
        window.setTimeout(() => {
          scheduleLayout();
        }, delay),
      );
    }

    const observedPopover = popoverRef.current;
    const resizeObserver =
      typeof ResizeObserver !== "undefined" && observedPopover
        ? new ResizeObserver(() => {
            scheduleLayout();
          })
        : null;
    resizeObserver?.observe(observedPopover as Element);

    runLayout();
    if (!hasSubPanel) {
      let frame = 0;
      const settleNoPanel = () => {
        rafRef.current = requestAnimationFrame(() => {
          runLayout();
          frame += 1;
          if (frame < NO_SUBPANEL_SETTLE_FRAMES) {
            settleNoPanel();
          }
        });
      };

      settleNoPanel();
      return () => {
        timers.forEach((id) => window.clearTimeout(id));
        resizeObserver?.disconnect();
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
      timers.forEach((id) => window.clearTimeout(id));
      resizeObserver?.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [
    hasSubPanel,
    lockedPopoverWidth,
    minPopoverWidth,
    panelMode,
    popoverRef,
    popoverState,
    stablePopoverWidth,
    selectionAnchor,
  ]);
}
