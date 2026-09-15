import { createSignal, Show } from "solid-js";

import { api } from "../api/client";
import { bootstrap } from "../state/sessions";

export default function AuthView() {
  const [registering, setRegistering] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const fields = (e: SubmitEvent) => {
    const data = new FormData(e.target as HTMLFormElement);
    return { email: String(data.get("email")), password: String(data.get("password")) };
  };

  const login = async (e: SubmitEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { email, password } = fields(e);
      await api.login(email, password);
      await bootstrap();
    } catch {
      // Bad credentials are a 400 here, so this never collides with apiFetch's
      // global 401 handling.
      setError("Wrong email or password.");
    } finally {
      setBusy(false);
    }
  };

  const register = async (e: SubmitEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { email, password } = fields(e);
    try {
      await api.register(email, password);
    } catch {
      setError("Registration failed.");
      setBusy(false);
      return;
    }
    try {
      // Registering doesn't sign you in; fastapi-users needs the login call too.
      await api.login(email, password);
      await bootstrap();
    } catch {
      setError("Account created -- please sign in.");
      setRegistering(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="auth-view">
      <h1>ADK demo</h1>
      <Show
        when={registering()}
        fallback={
          <form onSubmit={login}>
            <h2>Sign in</h2>
            <label>
              Email <input type="email" name="email" required autocomplete="username" />
            </label>
            <label>
              Password <input type="password" name="password" required autocomplete="current-password" />
            </label>
            <button type="submit" disabled={busy()}>
              Sign in
            </button>
          </form>
        }
      >
        <form onSubmit={register}>
          <h2>Create account</h2>
          <label>
            Email <input type="email" name="email" required autocomplete="username" />
          </label>
          <label>
            Password <input type="password" name="password" required autocomplete="new-password" />
          </label>
          <button type="submit" disabled={busy()}>
            Create account
          </button>
        </form>
      </Show>
      <p class="error">{error()}</p>
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); setError(""); setRegistering(!registering()); }}>
          {registering() ? "Have an account?" : "Need an account?"}
        </a>
      </p>
    </main>
  );
}
