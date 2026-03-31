import { useMemo } from "react";
import {
  clearDebugLogs,
  formatDebugLogs,
  type DebugLogEntry,
} from "@/services/debugLog";
import { evaluateLayoutAcceptance } from "@/services/layoutAcceptance";

interface DebugLogPopupProps {
  logs: DebugLogEntry[];
}

export function DebugLogPopup({ logs }: DebugLogPopupProps) {
  const text = useMemo(() => formatDebugLogs(logs), [logs]);
  const acceptance = useMemo(() => evaluateLayoutAcceptance(logs), [logs]);
  const statusLabel = !acceptance.hasData
    ? "WAITING"
    : acceptance.pass
      ? "PASS"
      : "FAIL";

  const copyLogs = async () => {
    if (!text.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
  };

  const copyAcceptance = async () => {
    const lines = [
      `Acceptance: ${statusLabel}`,
      `Snapshots: ${acceptance.totalSnapshots}`,
      `Failed snapshots: ${acceptance.failedSnapshots}`,
      `No popover overlap: ${acceptance.hasData ? (acceptance.criteria.noPopoverOverlap ? "PASS" : "FAIL") : "WAITING"}`,
      `No selection overlap: ${acceptance.hasData ? (acceptance.criteria.noSelectionOverlap ? "PASS" : "FAIL") : "WAITING"}`,
      `No viewport overflow: ${acceptance.hasData ? (acceptance.criteria.noViewportOverflow ? "PASS" : "FAIL") : "WAITING"}`,
      `Near selection: ${acceptance.hasData ? (acceptance.criteria.nearSelection ? "PASS" : "FAIL") : "WAITING"}`,
      `Latest distance: ${
        acceptance.latestDistance === null
          ? "N/A"
          : Math.round(acceptance.latestDistance)
      }`,
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      return;
    }
  };

  return (
    <section className="apl-debug-log-root">
      <div className="apl-debug-log-panel" role="region" aria-label="Debug logs">
        <header className="apl-debug-log-header">
          <h3>Debug Logs ({logs.length})</h3>
          <div className="apl-debug-log-actions">
            <button type="button" onClick={() => void copyLogs()}>
              Copy
            </button>
            <button type="button" onClick={() => void copyAcceptance()}>
              Copy Acceptance
            </button>
            <button type="button" onClick={() => clearDebugLogs()}>
              Clear
            </button>
          </div>
        </header>
        <section className="apl-debug-acceptance" aria-label="Acceptance criteria">
          <p
            className={`apl-debug-acceptance-status${
              statusLabel === "PASS"
                ? " is-pass"
                : statusLabel === "FAIL"
                  ? " is-fail"
                  : ""
            }`}
          >
            Acceptance {statusLabel}
          </p>
          <p>
            Snapshots {acceptance.totalSnapshots} | Failed {acceptance.failedSnapshots} | Latest distance {acceptance.latestDistance === null ? "N/A" : Math.round(acceptance.latestDistance)}
          </p>
          <p>No popover overlap: {acceptance.hasData ? (acceptance.criteria.noPopoverOverlap ? "PASS" : "FAIL") : "WAITING"}</p>
          <p>No selection overlap: {acceptance.hasData ? (acceptance.criteria.noSelectionOverlap ? "PASS" : "FAIL") : "WAITING"}</p>
          <p>No viewport overflow: {acceptance.hasData ? (acceptance.criteria.noViewportOverflow ? "PASS" : "FAIL") : "WAITING"}</p>
          <p>Near selection: {acceptance.hasData ? (acceptance.criteria.nearSelection ? "PASS" : "FAIL") : "WAITING"}</p>
        </section>
        <textarea
          className="apl-debug-log-text"
          readOnly
          value={text}
          placeholder="No logs yet"
        />
      </div>
    </section>
  );
}
