import { For } from "solid-js";

import { newChat, sessions } from "../state/sessions";
import SessionItem from "./SessionItem";

export default function Sidebar() {
  return (
    <aside id="sidebar">
      <button id="new-chat-button" onClick={() => newChat()}>
        + New chat
      </button>
      <ul id="session-list">
        <For each={sessions.list}>{(session) => <SessionItem session={session} />}</For>
      </ul>
    </aside>
  );
}
