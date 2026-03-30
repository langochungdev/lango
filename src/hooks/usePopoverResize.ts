// Resize popover window khi SubPanel toggle để có đủ không gian hiển thị
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const BASE_WIDTH = 360;
const BASE_HEIGHT = 300;
const SUBPANEL_DETAIL_WIDTH = 440;
const SUBPANEL_IMAGE_WIDTH = 520;
const GAP = 8;
const EXTRA_VERTICAL = 80;

export function usePopoverResize(
  popoverRef: React.RefObject<HTMLElement | null>,
  hasSubPanel: boolean,
  panelMode: string,
  lockedPopoverWidth: number | null,
) {
  const resizedRef = useRef(false);

  useEffect(() => {
    const popover = popoverRef.current;

    if (!hasSubPanel) {
      if (popover) {
        popover.style.removeProperty("width");
        popover.style.removeProperty("max-width");
      }

      if (resizedRef.current) {
        resizedRef.current = false;
        void invoke("resize_popover", {
          width: BASE_WIDTH,
          height: BASE_HEIGHT,
        });
      }
      return;
    }

    const measuredWidth = popover ? popover.offsetWidth : BASE_WIDTH;
    const lockedWidth = lockedPopoverWidth ?? measuredWidth;

    if (popover) {
      popover.style.width = `${lockedWidth}px`;
      popover.style.maxWidth = `${lockedWidth}px`;
    }

    const subW =
      panelMode === "images" ? SUBPANEL_IMAGE_WIDTH : SUBPANEL_DETAIL_WIDTH;
    const totalW = lockedWidth + GAP + subW + 24;
    const totalH =
      BASE_HEIGHT + EXTRA_VERTICAL + (panelMode === "images" ? 160 : 80);

    const width = Math.max(totalW, BASE_WIDTH);
    const height = Math.max(totalH, BASE_HEIGHT);

    resizedRef.current = true;
    void invoke("resize_popover", { width, height });
  }, [hasSubPanel, lockedPopoverWidth, panelMode, popoverRef]);
}
