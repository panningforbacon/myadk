import { Show } from "solid-js";

import { logout, sessions } from "../state/sessions";
import Composer from "./Composer";
import Sidebar from "./Sidebar";
import Transcript from "./Transcript";

export default function ChatView() {
  return (
    <main id="chat-view">
      <Sidebar />
      <Show when={sessions.currentId}>
        {(sessionId) => (
          <section id="chat-pane">
            <header>
              <span id="session-label">session {sessionId().slice(0, 8)}</span>
              <button onClick={() => logout()}>Log out</button>
            </header>
            <Transcript sessionId={sessionId()} />
            <Composer sessionId={sessionId()} />
          </section>
        )}
      </Show>
    </main>
  );
}
