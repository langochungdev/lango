import type { DebugLogEntry } from "@/services/debugLog";

interface LayoutOverlap {
  popover: number;
  selection: number;
}

interface LayoutPayload {
  overlap?: LayoutOverlap;
  viewportOverflow?: number;
  popoverDistanceToSelection?: number;
  popoverFarFromSelection?: boolean;
}

export interface LayoutAcceptanceSummary {
  hasData: boolean;
  pass: boolean;
  totalSnapshots: number;
  failedSnapshots: number;
  latestDistance: number | null;
  criteria: {
    noPopoverOverlap: boolean;
    noSelectionOverlap: boolean;
    noViewportOverflow: boolean;
    nearSelection: boolean;
  };
}

function isLayoutSnapshot(entry: DebugLogEntry): boolean {
  return (
    entry.scope === "layout" &&
    (entry.message === "Subpanel layout snapshot" ||
      entry.message === "Subpanel layout criteria failed")
  );
}

function parseLayoutPayload(detail?: string): LayoutPayload | null {
  if (!detail) {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as LayoutPayload;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toMetricList(logs: DebugLogEntry[]): LayoutPayload[] {
  return logs
    .filter(isLayoutSnapshot)
    .map((entry) => parseLayoutPayload(entry.detail))
    .filter((value): value is LayoutPayload => value !== null);
}

function readOverlapValue(
  payload: LayoutPayload,
  key: "popover" | "selection",
): number {
  const value = payload.overlap?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOverflowValue(payload: LayoutPayload): number {
  const value = payload.viewportOverflow;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNearSelection(payload: LayoutPayload): boolean {
  if (typeof payload.popoverFarFromSelection === "boolean") {
    return !payload.popoverFarFromSelection;
  }
  const distance = payload.popoverDistanceToSelection;
  if (
    typeof distance !== "number" ||
    !Number.isFinite(distance) ||
    distance < 0
  ) {
    return true;
  }
  return distance <= 420;
}

export function evaluateLayoutAcceptance(
  logs: DebugLogEntry[],
): LayoutAcceptanceSummary {
  const snapshots = toMetricList(logs);
  if (snapshots.length === 0) {
    return {
      hasData: false,
      pass: false,
      totalSnapshots: 0,
      failedSnapshots: 0,
      latestDistance: null,
      criteria: {
        noPopoverOverlap: false,
        noSelectionOverlap: false,
        noViewportOverflow: false,
        nearSelection: false,
      },
    };
  }

  let noPopoverOverlap = true;
  let noSelectionOverlap = true;
  let noViewportOverflow = true;
  let nearSelection = true;
  let failedSnapshots = 0;

  for (const payload of snapshots) {
    const popoverOverlap = readOverlapValue(payload, "popover");
    const selectionOverlap = readOverlapValue(payload, "selection");
    const viewportOverflow = readOverflowValue(payload);
    const isNearSelection = readNearSelection(payload);

    if (popoverOverlap > 0) {
      noPopoverOverlap = false;
    }
    if (selectionOverlap > 0) {
      noSelectionOverlap = false;
    }
    if (viewportOverflow > 0) {
      noViewportOverflow = false;
    }
    if (!isNearSelection) {
      nearSelection = false;
    }

    if (
      popoverOverlap > 0 ||
      selectionOverlap > 0 ||
      viewportOverflow > 0 ||
      !isNearSelection
    ) {
      failedSnapshots += 1;
    }
  }

  const latest = snapshots[snapshots.length - 1];
  const latestDistance =
    typeof latest.popoverDistanceToSelection === "number" &&
    Number.isFinite(latest.popoverDistanceToSelection)
      ? latest.popoverDistanceToSelection
      : null;

  const pass =
    noPopoverOverlap &&
    noSelectionOverlap &&
    noViewportOverflow &&
    nearSelection;

  return {
    hasData: true,
    pass,
    totalSnapshots: snapshots.length,
    failedSnapshots,
    latestDistance,
    criteria: {
      noPopoverOverlap,
      noSelectionOverlap,
      noViewportOverflow,
      nearSelection,
    },
  };
}
