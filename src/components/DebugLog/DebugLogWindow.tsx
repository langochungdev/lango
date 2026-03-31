import { useEffect, useState } from "react";
import { DebugLogPopup } from "@/components/DebugLog/DebugLogPopup";
import {
  readDebugLogs,
  subscribeDebugLogUpdates,
  type DebugLogEntry,
} from "@/services/debugLog";

export function DebugLogWindow() {
  const [logs, setLogs] = useState<DebugLogEntry[]>(() => readDebugLogs());

  useEffect(() => {
    const refresh = () => {
      setLogs(readDebugLogs());
    };

    const unsubscribe = subscribeDebugLogUpdates(refresh);
    refresh();

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <main className="apl-debug-window-shell">
      <DebugLogPopup logs={logs} />
    </main>
  );
}
