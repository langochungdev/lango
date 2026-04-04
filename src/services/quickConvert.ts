import { invoke } from "@tauri-apps/api/core";
import { sidecarPost } from "@/services/tauri";

export interface QuickConvertWordData {
  input: string;
  phonetic?: string | null;
  audio_url?: string | null;
  audio_lang?: string | null;
  synonyms: string[];
  related: string[];
  sounds_like: string[];
}

export interface QuickConvertResult {
  kind: "word" | "text";
  result: string;
  engine: string;
  mode: string;
  fallback_used: boolean;
  word_data: QuickConvertWordData | null;
}

export interface QuickConvertRequest {
  text: string;
  source: string;
  target: string;
}

export async function quickConvertText(
  request: QuickConvertRequest,
): Promise<QuickConvertResult> {
  const hasBridge =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (hasBridge) {
    try {
      return await invoke<QuickConvertResult>("quick_convert_text", {
        payload: request,
      });
    } catch (invokeError) {
      const invokeErrorMessage =
        invokeError instanceof Error
          ? invokeError.message
          : String(invokeError);
      console.error(
        "[quick-convert] invoke failed, fallback to sidecar fetch",
        {
          source: request.source,
          target: request.target,
          textLength: request.text.length,
          invokeError: invokeErrorMessage,
        },
      );
      throw new Error(`quick-convert:invoke-failed:${invokeErrorMessage}`);
    }
  }

  try {
    return await sidecarPost<QuickConvertResult>("/quick-convert", request);
  } catch (fetchError) {
    const fetchMessage =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    console.error("[quick-convert] sidecar fetch failed", {
      source: request.source,
      target: request.target,
      textLength: request.text.length,
      endpoint: "http://127.0.0.1:49152/quick-convert",
      fetchError: fetchMessage,
      phase: "direct-fetch-no-bridge",
    });
    throw new Error(
      `quick-convert:direct-fetch-no-bridge:fetch=${fetchMessage}`,
    );
  }
}
