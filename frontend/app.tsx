import { createSignal, onMount, Show } from "solid-js";

/** Placeholder until the UI port. Its only job is to prove the pipeline end to
 * end: a same-origin /api call that behaves identically through the Vite proxy
 * in dev and against FastAPI's static mount in prod.
 *
 * Deliberately signals + onMount rather than createResource -- Solid 2.0 drops
 * createResource, and paying that migration cost starts here or never. */
export default function App() {
  const [status, setStatus] = createSignal("checking backend…");
  const [failed, setFailed] = createSignal(false);

  onMount(async () => {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { status: string };
      setStatus(`backend ${body.status}`);
    } catch (err) {
      setFailed(true);
      setStatus(`backend unreachable: ${err}`);
    }
  });

  return (
    <main>
      <h1>ADK chat</h1>
      <Show when={failed()} fallback={<p class="ok">{status()}</p>}>
        <p class="bad">{status()}</p>
      </Show>
    </main>
  );
}
