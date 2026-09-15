import { For, Show } from "solid-js";

import type { Message as MessageData } from "../state/chats";

/** Thought parts render collapsed. They're the model's reasoning, useful on
 * demand and noise by default -- and mixing them into the answer is the exact
 * bug §4 spent a day chasing. */
export default function Message(props: { message: MessageData }) {
  return (
    <div class={`turn ${props.message.role}`}>
      <For each={props.message.parts}>
        {(part) => (
          <Show when={part.kind === "thought"} fallback={<span>{part.text}</span>}>
            <details class="thought">
              <summary>thinking</summary>
              {part.text}
            </details>
          </Show>
        )}
      </For>
    </div>
  );
}
