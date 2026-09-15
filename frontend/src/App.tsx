import { Match, onMount, Switch } from "solid-js";

import AuthView from "./components/AuthView";
import ChatView from "./components/ChatView";
import { auth } from "./state/auth";
import { bootstrap } from "./state/sessions";

export default function App() {
  onMount(() => void bootstrap());

  return (
    <Switch fallback={<main id="auth-view">
      <p>loading…</p>
    </main>}>
      <Match when={auth() === "anon"}>
        <AuthView />
      </Match>
      <Match when={auth() === "authed"}>
        <ChatView />
      </Match>
    </Switch>
  );
}
