import { createStore } from "solid-js/store";

import { api, HttpError } from "../api/client";
import type { SessionSummary } from "../api/types";
import { setAuth } from "./auth";
import { abortAll, abortStream, isStreaming, loadTranscript, resetChat } from "./chats";

type SessionState = { list: SessionSummary[]; currentId: string | null };

const [sessions, setSessions] = createStore<SessionState>({ list: [], currentId: null });

export { sessions };

const byRecency = (list: SessionSummary[]) => [...list].sort((a, b) => b.last_update_time - a.last_update_time);

export async function refreshList(): Promise<void> {
  const { sessions: list } = await api.listSessions();
  setSessions("list", byRecency(list));
}

/** Resume-most-recent, or create. No session picker existed when this policy
 * was written; "most recently updated" still stands in for "where you were." */
async function pickOrCreate(list: SessionSummary[]): Promise<string> {
  const [newest] = byRecency(list);
  if (newest) return newest.session_id;
  const { session_id } = await api.createSession();
  return session_id;
}

export async function selectSession(sessionId: string): Promise<void> {
  let id = sessionId;
  try {
    // A session listed but streaming has live state in the store that a refetch
    // would clobber with a transcript missing the in-flight turn.
    if (!isStreaming(id)) await loadTranscript(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      // Listed server-side, gone by the time we asked. Self-heal into a fresh
      // session rather than stranding the user on a dead one.
      const { session_id } = await api.createSession();
      id = session_id;
      resetChat(id);
    } else {
      throw err;
    }
  }
  // Unconditional: the view transition is not allowed to depend on the history
  // fetch succeeding.
  setSessions("currentId", id);
  await refreshList();
}

export async function resumeOrCreate(): Promise<void> {
  const { sessions: list } = await api.listSessions();
  setSessions("list", byRecency(list));
  await selectSession(await pickOrCreate(list));
}

export async function newChat(): Promise<void> {
  // Deliberately skips pickOrCreate: not resuming is this button's entire job.
  const { session_id } = await api.createSession();
  resetChat(session_id);
  await selectSession(session_id);
}

export async function removeSession(sessionId: string): Promise<void> {
  abortStream(sessionId); // deleting the session being streamed into is the one case that aborts
  await api.deleteSession(sessionId);
  if (sessionId === sessions.currentId) {
    await resumeOrCreate();
  } else {
    await refreshList();
  }
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await api.renameSession(sessionId, title);
  await refreshList();
}

/** The title response already carries the answer, so patch the list in place
 * rather than refetching it. */
export function applyTitle(sessionId: string, title: string): void {
  const index = sessions.list.findIndex((s) => s.session_id === sessionId);
  if (index >= 0) setSessions("list", index, "title", title);
}

export async function bootstrap(): Promise<void> {
  try {
    await resumeOrCreate();
    setAuth("authed");
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) return; // apiFetch already set "anon"
    console.error(err);
    setAuth("anon");
  }
}

export async function logout(): Promise<void> {
  abortAll();
  await api.logout().catch(() => {});
  setSessions({ list: [], currentId: null });
  setAuth("anon");
}
