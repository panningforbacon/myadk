import type { components } from "./schema";

export type SessionSummary = components["schemas"]["SessionSummary"];
export type TurnOut = components["schemas"]["TurnOut"];
export type PartOut = components["schemas"]["PartOut"];
export type PartKind = PartOut["kind"];

/**
 * Hand-maintained, unlike everything else in this file.
 * 
 * StreamingResponse bodies don't appear in OpenAPI -- /api/chat/stream
 * generates as `application/json: unknown` -- so this union is the one place
 * frontend and backend can drift without tsc noticing. Keep it in step with
 * _ndjson() in app/main.py.
 */
export type StreamLine =
  | { type: "text"; delta: string }
  | { type: "thought"; delta: string }
  // Carries `title`, not `delta`: a name replaces, it doesn't accumulate.
  | { type: "title"; title: string }
  | { type: "error"; code: "stale_session" | "model" | "internal" }
  | { type: "done" };