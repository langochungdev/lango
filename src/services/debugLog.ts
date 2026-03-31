export interface DebugLogEntry {
  id: string;
  at: string;
  scope: string;
  message: string;
  detail?: string;
}

const LOG_KEY = "dictover-debug-log";
const MAX_LOG_COUNT = 300;
const LOG_UPDATED_EVENT = "dictover-debug-log-updated";
const LOG_BROADCAST_CHANNEL = "dictover-debug-log-channel";

function createBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (typeof window.BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(LOG_BROADCAST_CHANNEL);
}

function notifyLogUpdated(source: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(LOG_UPDATED_EVENT));

  const channel = createBroadcastChannel();
  if (channel) {
    channel.postMessage({ type: "updated", source, at: Date.now() });
    channel.close();
  }
}

function safeParse(raw: string | null): DebugLogEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as DebugLogEntry[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

export function readDebugLogs(): DebugLogEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  return safeParse(localStorage.getItem(LOG_KEY));
}

export function clearDebugLogs(): void {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(LOG_KEY, JSON.stringify([]));
  notifyLogUpdated("clear");
}

export function appendDebugLog(
  scope: string,
  message: string,
  detail?: string,
): DebugLogEntry {
  const entry: DebugLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    scope,
    message,
    detail,
  };

  if (typeof window === "undefined") {
    return entry;
  }

  const current = readDebugLogs();
  const next = [...current, entry].slice(-MAX_LOG_COUNT);
  localStorage.setItem(LOG_KEY, JSON.stringify(next));
  notifyLogUpdated("append");

  return entry;
}

export function subscribeDebugLogUpdates(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {
      return;
    };
  }

  const run = () => {
    onChange();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === LOG_KEY) {
      run();
    }
  };

  const channel = createBroadcastChannel();
  const onChannelMessage = () => {
    run();
  };

  window.addEventListener(LOG_UPDATED_EVENT, run);
  window.addEventListener("storage", onStorage);

  if (channel) {
    channel.addEventListener("message", onChannelMessage);
  }

  const timerId = window.setInterval(run, 1200);

  return () => {
    window.removeEventListener(LOG_UPDATED_EVENT, run);
    window.removeEventListener("storage", onStorage);
    window.clearInterval(timerId);
    if (channel) {
      channel.removeEventListener("message", onChannelMessage);
      channel.close();
    }
  };
}

export function formatDebugLogs(entries: DebugLogEntry[]): string {
  return entries
    .map((entry) => {
      const timestamp = entry.at.replace("T", " ").replace("Z", "");
      const suffix = entry.detail ? ` | ${entry.detail}` : "";
      return `[${timestamp}] [${entry.scope}] ${entry.message}${suffix}`;
    })
    .join("\n");
}
