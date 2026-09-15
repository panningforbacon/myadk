import { createStore } from "solid-js/store";

import { api } from "../api/client";
import { streamChat } from "../api/stream";
import type { PartKind, StreamLine } from "../api/types";

export type Status = "idle" | "loading" | "streaming" | "error" | "interrupted";

export type Part = { kind: PartKind; text: string };
export type Message = { role: string; parts: Part[] };
export type ChatState = { messages: Message[]; status: Status; errorCode?: string };

const [chats, setChats] = createStore<Record<string, ChatState>>({});

export { chats };

export function ensureChat(sessionId: string): void {
  if (!chats[sessionId]) setChats(sessionId, { messages: [], status: "idle" });
}

export function resetChat(sessionId: string): void {
  setChats(sessionId, { messages: [], status: "idle", errorCode: undefined });
}

export async function loadTranscript(sessionId: string): Promise<void> {
  ensureChat(sessionId);
  setChats(sessionId, "status", "loading");
  const { turns } = await api.transcript(sessionId);
  setChats(sessionId, { messages: turns.map((t) => ({ role: t.role, parts: t.parts })), status: "idle", errorCode: undefined });
}

function appendDelta(sessionId: string, kind: PartKind, delta: string): void {
  const messages = chats[sessionId].messages;
  const last = messages.length - 1;
  const parts = messages[last].parts;
  const tail = parts.length - 1;

  // Merge into the trailing part when the kind matches, so a reply arriving as
  // forty deltas renders as one paragraph rather than forty.
  if (tail >= 0 && parts[tail].kind === kind) {
    setChats(sessionId, "messages", last, "parts", tail, "text", (text) => text + delta);
  } else {
    setChats(sessionId, "messages", last, "parts", (current) => [...current, { kind, text: delta }]);
  }
}

/** The whole wire protocol, reduced into state, in one place. */
export function applyLine(sessionId: string, line: StreamLine): void {
  switch (line.type) {
    case "text":
    case "thought":
      appendDelta(sessionId, line.type, line.delta);
      break;
    case "done":
      setChats(sessionId, "status", "idle");
      break;
    case "error":
      setChats(sessionId, { status: "error", errorCode: line.code });
      break;
    default: {
      // Unknown types are ignored by contract, which is what makes tool_call
      // and grounding additive later rather than a breaking change.
      const unrecognized: { type: string } = line;
      console.warn("ignoring unknown stream line:", unrecognized.type);
    }
  }
}

const inflight = new Map<string, AbortController>();

export const isStreaming = (sessionId: string): boolean => inflight.has(sessionId);

/** Only for teardown -- deleting the session being streamed, or logging out.
 * Merely switching away does not abort: see sendMessage. */
export function abortStream(sessionId: string): void {
  inflight.get(sessionId)?.abort();
  inflight.delete(sessionId);
}

export function abortAll(): void {
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
}

export async function sendMessage(sessionId: string, message: string, onTitle: (id: string, title: string) => void): Promise<void> {
  ensureChat(sessionId);
  const isFirstTurn = chats[sessionId].messages.length === 0;

  // Path setters rather than produce(): Solid 2.0 removes produce, and the
  // migration is smaller if it was never adopted.
  setChats(sessionId, "messages", (messages) => [...messages, { role: "user", parts: [{ kind: "text" as const, text: message }] }, { role: "assistant", parts: [] }]);
  setChats(sessionId, { status: "streaming", errorCode: undefined });

  if (isFirstTurn) {
    // Fired before the stream is awaited, not after it: the two requests are
    // meant to race, which is precisely what rename_session's retry loop exists
    // to absorb. Never awaited -- a slow or failed title must not touch the reply.
    void api
      .generateTitle(sessionId, message)
      .then(({ title }) => onTitle(sessionId, title))
      .catch((err) => console.error("title generation failed:", err));
  }

  const controller = new AbortController();
  inflight.set(sessionId, controller);

  try {
    for await (const line of streamChat(sessionId, message, controller.signal)) {
      applyLine(sessionId, line);
    }
    // Neither done nor error arrived: the connection died mid-turn. The only
    // reason the client can tell this apart from a finished reply.
    if (chats[sessionId].status === "streaming") setChats(sessionId, "status", "interrupted");
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    setChats(sessionId, { status: "error", errorCode: "network" });
  } finally {
    inflight.delete(sessionId);
  }
}
