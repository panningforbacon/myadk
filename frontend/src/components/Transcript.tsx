import { createEffect, For, Show } from "solid-js";

import { chats } from "../state/chats";
import Message from "./Message";

const STATUS_NOTE: Record<string, string> = {
  error: "Something went wrong -- see console.",
  interrupted: "The reply was cut off before it finished.",
};

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
      <Show when={STATUS_NOTE[chat()?.status ?? ""]}>
        {(note) => <p class="error">{note()}</p>}
      </Show>
    </div>
  );
}
