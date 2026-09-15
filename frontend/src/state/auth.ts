import { createSignal } from "solid-js";

/** "unknown" only until the first request answers; it keeps the app from
 * flashing the login form at someone who is already signed in. */
export type AuthState = "unknown" | "anon" | "authed";

const [auth, setAuth] = createSignal<AuthState>("unknown");

export { auth, setAuth };
