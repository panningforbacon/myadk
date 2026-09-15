import { apiFetch } from "./client";
import type { StreamLine } from "./types";

/**
 * The only code in the app that touches the response body. Everything upstream
 * sees typed lines, so swapping the wire format again would land here alone.
 */
export async function* streamChat(sessionId: string, message: string, signal: AbortSignal): AsyncGenerator<StreamLine> {
  const res = await apiFetch("/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, message }),
    signal,
  });

  // TextDecoderStream, not TextDecoder by hand: it keeps a multibyte character
  // split across two chunks from decoding into replacement characters.
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

    // A chunk boundary is not a line boundary: carry the partial tail forward.
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as StreamLine;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as StreamLine;
  } finally {
    // Runs on abort too, when the generator is closed early rather than exhausted.
    await reader.cancel().catch(() => {});
  }
}
