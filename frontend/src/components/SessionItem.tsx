import { createSignal, Show } from "solid-js";

import type { SessionSummary } from "../api/types";
import { removeSession, renameSession, selectSession, sessions } from "../state/sessions";

export default function SessionItem(props: { session: SessionSummary }) {
  const [editing, setEditing] = createSignal(false);
  // Not a signal: nothing renders from it, and it must be readable synchronously
  // inside the blur handler that Escape is racing.
  let cancelled = false;
  let input!: HTMLInputElement;

  const title = () => props.session.title || "Untitled";
  const isActive = () => props.session.session_id === sessions.currentId;

  const startEditing = () => {
    cancelled = false;
    setEditing(true);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  };

  const commit = async () => {
    if (cancelled) return; // Escape already unmounted the input; blur is the echo
    setEditing(false);
    const next = input.value.trim();
    if (next && next !== props.session.title) await renameSession(props.session.session_id, next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") input.blur(); // let blur be the single commit path
    if (e.key === "Escape") {
      cancelled = true;
      setEditing(false);
    }
  };

  const confirmDelete = async () => {
    if (!confirm("Delete this session? This can't be undone.")) return;
    await removeSession(props.session.session_id);
  };

  return (
    <li class={`session-item${isActive() ? " active" : ""}`}>
      <Show
        when={editing()}
        fallback={
          <span class="title" title={title()} onClick={() => selectSession(props.session.session_id)}>
            {title()}
          </span>
        }
      >
        <input class="title-input" ref={input} value={props.session.title ?? ""} placeholder="New chat" onBlur={commit} onKeyDown={onKeyDown} />
      </Show>
      <button class="icon-button" type="button" title="Rename" onClick={startEditing}>
        ✎
      </button>
      <button class="icon-button" type="button" title="Delete" onClick={confirmDelete}>
        ✕
      </button>
    </li>
  );
}
