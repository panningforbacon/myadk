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

/** The whole wire protocol, reduced into state, in one place.
 *
 * onTitle is a parameter rather than an import: sessions.ts already imports
 * this module, so reaching back for applyTitle would close the cycle. */
export function applyLine(sessionId: string, line: StreamLine, onTitle: (id: string, title: string) => void): void {
  switch (line.type) {
    case "text":
    case "thought":
      appendDelta(sessionId, line.type, line.delta);
      break;
    case "title":
      // The server names the session now, so this arrives mid-stream rather
      // than from a second request racing this one.
      onTitle(sessionId, line.title);
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

  // Path setters rather than produce(): Solid 2.0 removes produce, and the
  // migration is smaller if it was never adopted.
  setChats(sessionId, "messages", (messages) => [...messages, { role: "user", parts: [{ kind: "text" as const, text: message }] }, { role: "assistant", parts: [] }]);
  setChats(sessionId, { status: "streaming", errorCode: undefined });

  const controller = new AbortController();
  inflight.set(sessionId, controller);

  try {
    for await (const line of streamChat(sessionId, message, controller.signal)) {
      applyLine(sessionId, line, onTitle);
    }
    // Neither done nor error arrived: the connection died mid-turn. The only
    // reason the client can tell this apart from a finished reply.
    if (chats[sessionId].status === "streaming") setChats(sessionId, "status", "interrupted");

    if (chats[sessionId].errorCode === "stale_session") {
      // The reply on screen was never persisted. Refetching is the only way the
      // display and the stored history agree about what happened.
      await loadTranscript(sessionId);
      setChats(sessionId, { status: "error", errorCode: "stale_session" }); // loadTranscript clears both
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    setChats(sessionId, { status: "error", errorCode: "network" });
  } finally {
    inflight.delete(sessionId);
  }
}