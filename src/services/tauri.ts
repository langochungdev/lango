import { invoke } from "@tauri-apps/api/core";

const sidecarHostFromEnv = String(
  import.meta.env.VITE_SIDECAR_HOST || "",
).trim();
const sidecarPortFromEnv = String(
  import.meta.env.VITE_SIDECAR_PORT || "",
).trim();
const sidecarHost = sidecarHostFromEnv || "127.0.0.1";
const sidecarPort = sidecarPortFromEnv || "49152";
const SIDECAR_BASE_URL = `http://${sidecarHost}:${sidecarPort}`;
const BRIDGE_INVOKE_TIMEOUT_MS = 2300;
const SIDECAR_HEALTH_WAIT_TIMEOUT_MS = 2600;
const SIDECAR_HEALTH_REQUEST_TIMEOUT_MS = 700;
const SIDECAR_REQUEST_TIMEOUT_MS = 6500;
const SIDECAR_RETRY_DELAYS_MS = [120, 260] as const;

let sidecarPrimed = false;

export function sidecarUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SIDECAR_BASE_URL}${normalized}`;
}

function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new Error(`request timeout after ${timeoutMs}ms`);
    }
    throw cause;
  } finally {
    clearTimeout(timerId);
  }
}

async function waitForSidecarHealth(maxWaitMs: number): Promise<boolean> {
  const endpoint = sidecarUrl("/health");
  const deadline = Date.now() + maxWaitMs;
  let delayMs = 80;

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(
        endpoint,
        { method: "GET" },
        SIDECAR_HEALTH_REQUEST_TIMEOUT_MS,
      );
      if (response.ok) {
        return true;
      }
    } catch {
      // Ignore transient startup connection failures; retry until deadline.
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 320);
  }

  return false;
}

async function ensureSidecarPrimed(): Promise<void> {
  if (sidecarPrimed) {
    return;
  }

  const healthy = await waitForSidecarHealth(SIDECAR_HEALTH_WAIT_TIMEOUT_MS);
  if (healthy) {
    sidecarPrimed = true;
  }
}

export async function invokeWithFallback<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!hasTauriBridge()) {
    return fallback();
  }
  try {
    const result = await withTimeout(
      invoke<T>(command, args),
      BRIDGE_INVOKE_TIMEOUT_MS,
      `invoke:${command}`,
    );
    return result;
  } catch {
    return fallback();
  }
}

export async function sidecarPost<T>(path: string, body: unknown): Promise<T> {
  await ensureSidecarPrimed();

  const endpoint = sidecarUrl(path);
  let lastError = "unknown sidecar error";

  for (
    let attempt = 0;
    attempt <= SIDECAR_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        SIDECAR_REQUEST_TIMEOUT_MS,
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const message = `Sidecar request failed with status ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`;
        if (response.status < 500) {
          throw new Error(`non-retryable:${message}`);
        }
        throw new Error(message);
      }

      const payload = (await response.json()) as T;
      sidecarPrimed = true;
      return payload;
    } catch (cause) {
      const message = describeError(cause);
      lastError = message;

      const nonRetryable = message.startsWith("non-retryable:");
      const exhausted = attempt >= SIDECAR_RETRY_DELAYS_MS.length;
      if (nonRetryable || exhausted) {
        break;
      }

      await sleep(SIDECAR_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw new Error(`Sidecar request failed after retries: ${lastError}`);
}
