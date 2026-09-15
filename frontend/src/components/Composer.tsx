import { createSignal } from "solid-js";

import { chats, sendMessage } from "../state/chats";
import { applyTitle, refreshList } from "../state/sessions";

export default function Composer(props: { sessionId: string }) {
  const [draft, setDraft] = createSignal("");
  const busy = () => chats[props.sessionId]?.status === "streaming";

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const message = draft().trim();
    if (!message || busy()) return;
    setDraft("");
    // Captured, not read later: the user may switch sessions mid-stream.
    const sessionId = props.sessionId;
    await sendMessage(sessionId, message, applyTitle);
    await refreshList(); // the turn moved this session to the top of the list
  };

  return (
    <form id="chat-form" onSubmit={submit}>
      <textarea 
        id="chat-input" 
        rows="4"
        placeholder="Say something..."
        value={draft()}
        disabled={busy()}
        onInput={(e) => setDraft(e.currentTarget.value)}
      />
      {/* Disabling the whole form while streaming is what closes the
          double-submit gap the vanilla Send button left open. */}
      <button type="submit" disabled={busy() || !draft().trim()}>
        Send
      </button>
    </form>
  );
}
