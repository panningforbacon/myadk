import { createEffect, For, Show } from "solid-js";

import { chats } from "../state/chats";
import Message from "./Message";

/** errorCode has been stored since commit D and displayed by nobody. The codes
 * mean genuinely different things to a user -- retry, reload, or give up. */
const ERROR_NOTE: Record<string, string> = {
  model: "The model didn't finish this reply. Try again.",
  stale_session: "That reply was lost to a conflicting write and wasn't saved.",
  network: "The connection failed.",
  internal: "Something went wrong on the server.",
};

function note(status: string | undefined, errorCode: string | undefined): string | undefined {
  if (status === "interrupted") return "The reply was cut off before it finished.";
  if (status === "error") return ERROR_NOTE[errorCode ?? ""] ?? "Something went wrong.";
  return undefined;
}

export default function Transcript(props: { sessionId: string }) {
  let el!: HTMLDivElement;
  const chat = () => chats[props.sessionId];

  createEffect(() => {
    const messages = chat()?.messages ?? [];
    // Touch the deep values so this re-runs per delta, not only per message.
    messages.at(-1)?.parts.forEach((part) => part.text.length);
    el.scrollTop = el.scrollHeight;
  });

  return (
    <div id="transcript" ref={el} aria-live="polite">
      <For each={chat()?.messages ?? []}>{(message) => <Message message={message} />}</For>
      <Show when={note(chat()?.status, chat()?.errorCode)}>
        {(note) => <p class="error">{note()}</p>}
      </Show>
    </div>
  );
}