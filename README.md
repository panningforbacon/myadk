# adk-fastapi-demo Project History

A minimal Google ADK agent behind a FastAPI + Hypercorn backend, built iteratively
as a learning project. Each section below is a requirement and the strategy used
to meet it; bug fixes discovered later are folded into the iteration whose code
they touch, not broken out separately.

## History

### 1. Scaffold: ADK agent behind FastAPI + Hypercorn

**Requirement:** a minimal working agent, servable over HTTP, in a repo structure
that wouldn't need rearchitecting as features got added.

**Strategy:** `uv`-managed project, `google-adk>=2.0.0,<3.0.0` (resolved to 2.8.0),
`python-dotenv` for `GOOGLE_API_KEY` (`load_dotenv()` must run before any module
that reads env vars at import time — a recurring fragility, eventually fixed by
calling it redundantly at the top of both `core.py` and `db.py`).

Split the code three ways from the start:
- **`core.py`** — all ADK-facing logic, framework-agnostic. No FastAPI imports.
- **`main.py`** — thin HTTP adapter over `core.py`.
- **`cli.py`** — a separate REPL adapter (fixed `CLI_USER_ID`, one session per
  launch), for exercising `core.py` without a server.

This split paid off repeatedly: multi-user support, the SQLite→Postgres swap,
and streaming were all added later with **zero changes to `core.py`'s function
signatures**.

### 2. Multi-user sessions

**Requirement:** support more than one user without cross-contaminating history.

**Strategy:** started with a deterministic `session_id` (`f"{user_id}-session"`),
replaced entirely once "manage multiple sessions per user" became a real
requirement — session CRUD (`POST`/`GET`/`DELETE /sessions`), with the
**server** generating `session_id`s rather than accepting client-supplied ones,
closing off collision/replay.

### 3. Real authentication

**Requirement:** stop trusting a client-supplied `user_id`; support login/logout
with actual revocation.

**Strategy:** `fastapi-users` 15.x backed by SQLite (later Postgres-swappable).
Chose **`DatabaseStrategy`** over JWT specifically because logout needs to
*revoke* access by deleting the `access_token` row — a stateless JWT can't do
that. `User` / `AccessToken` tables live in the same database as ADK's own
session storage but in separate, independently-managed schemas.

### 4. Streaming responses

**Requirement:** stream the agent's reply to the client as it's generated,
not all at once.

**Strategy:** `RunConfig(streaming_mode=StreamingMode.SSE)` — confirmed via
source inspection to control `partial=True` delta-event emission; the name is
ADK's internal label for that behavior, not a commitment to the SSE wire
protocol. On the wire, chose `StreamingResponse` via `fetch()` +
`ReadableStream` over `EventSource`, because `EventSource` is GET-only (can't
carry a JSON body) and auto-reconnects, which is wrong mid-turn.

**Bug found later, fixed here:** `stream_message` read `event.content.parts[0].text`
unconditionally. Gemini 2.5 models think by default (`types.Part.thought: bool`,
distinct from the answer) unless `thinking_config` disables it — nothing in
`agent.py` does. The model's reasoning trace, which routinely recaps prior
turns while reasoning about a new one, was streaming straight into the chat
bubble and being written into the transcript, indistinguishable from a real
answer — surfacing as what looked like the first turn's response bleeding
into the second turn's.

Ruled out first, with actual reproductions (not just reading code), before
landing on the real cause:
- Frontend double-submission — structurally clean, ruled out by inspection.
- ADK replaying old session events into a later turn's stream — built a real
  `Runner` + `DatabaseSessionService` + a minimal fake agent, ran two genuine
  sequential turns, confirmed turn 2's yielded events contain nothing from
  turn 1.
- The `StaleSessionError` recovery path (see §7) corrupting the next turn —
  same rig, simulated turn 1 crashing mid-stream; turn 2 still came back clean.
  Also ruled out ADK's task-scope resume detection, since it's scoped to
  function-call/task-agent delegation and `root_agent` has neither.

Fix: a shared `_answer_text()` helper that returns the first *non-thought*
part's text, used in the streaming loop, its no-partials fallback branch, and
`get_transcript`. Verified against a fake agent that emits a thought part
followed by the real answer, streamed the same way Gemini would: only the
real answer reaches the client and the transcript.

### 5. Session storage: in-memory → database, SQLite → Postgres

**Requirement:** sessions need to survive a restart, and the storage backend
needs to be swappable between local dev (SQLite) and production (Postgres)
without app-level changes.

**Strategy:** `DatabaseSessionService(db_engine=engine)`, sharing the same
`AsyncEngine` already used for `fastapi-users` — one physical database, two
independently-versioned schemas. `DATABASE_URL` env var selects the backend
(`sqlite+aiosqlite:///...` for dev, `postgresql+asyncpg://...` for prod).

Verified for real, not just asserted: installed Postgres in-sandbox via apt,
ran the identical test suite against both backends, confirmed identical
results. Confirmed persistence-across-restart on both backends using genuinely
separate subprocess invocations — a single-process `TestClient` reuse pattern
crashes `asyncpg` (its connections are event-loop-bound), which turned out to
be a test-methodology artifact, not an app bug, resolved by re-testing via
separate `uv run python -c` subprocess calls.

Because of the `core.py`/`main.py` split from §1, this swap required **zero**
changes to any function signature in `core.py`.

### 6. Frontend

**Requirement:** a usable chat UI without turning this into a frontend project.

**Strategy:** vanilla JS, no framework, no build step — deliberately rejected a
SolidJS/bundler approach as contrary to the project's actual goal (learn
ADK/FastAPI, not frontend tooling), and same-origin static serving avoids
CORS/SameSite cookie complications a separate dev server would introduce.
Three view containers (`#auth-view`, `#chat-view`, sidebar + chat pane).
Static files mounted **last** in `main.py` (`StaticFiles(..., html=True)`),
confirmed via test that explicit API routes still take precedence — Starlette
matches routes in registration order.

**Bug found later, fixed here:** the sidebar's layout CSS added
`#chat-view { display: flex; height: 100%; }`. An ID selector (specificity
`1,0,0`) always outranks `[hidden] { display: none; }` (specificity `0,1,0`),
so `#chat-view` never actually hid regardless of the `hidden` attribute.
Fixed by conditioning the rule on `:not([hidden])` instead of reaching for
`!important`, which would only have set up the next specificity fight instead
of ending them. Checked every other ID-selector `display` rule in the
stylesheet for the same class of bug — none of those elements are ever
toggled via `.hidden`, so this was the only instance.

**Known, unfixed:** the "Send" button isn't disabled during streaming (only
the textarea is). It doesn't cause real resubmission — the textarea is
cleared and disabled, so there's nothing to send — but it's a real UI gap
worth closing.

### 7. Multi-session management: CRUD, rename, LLM-generated titles

**Requirement:** a session picker (list, switch, rename, delete), with titles
generated automatically from the first message rather than left blank.

**Strategy — title generation went through three designs:**
1. Starlette `BackgroundTask` (runs after the full response is sent) —
   abandoned because titling never even *started* until the reply had already
   fully rendered, adding latency for no reason.
2. `core.py`-internal `asyncio.create_task` with a strong-ref set to prevent
   GC of unawaited tasks — functional, but kept the frontend blind to when a
   title actually landed.
3. **Final:** the frontend fires two independent, concurrent `fetch()` calls —
   the chat request and `POST /sessions/{id}/title` — neither awaited against
   the other. `core.py` exposes a directly-awaited, idempotent
   `maybe_generate_title`, and new sessions get `state={"title": "Untitled"}`
   at creation (not via a later event) specifically so the endpoint's
   idempotency check — *is the title still "Untitled"?* — is race-free against
   the chat call's own concurrent event-appending. Checking the title's
   **value**, not turn/event count, was the detail that made this race-free.

`title_agent` is a second, independent `Agent` + `Runner`, deliberately **not**
a `sub_agent` of `root_agent` — ADK's `sub_agents` delegation is model-decided
within one session, the wrong fit for an unconditional backend-triggered side
task. A separate `Runner` sharing the same `session_service` under a distinct
`TITLE_APP_NAME` gives free storage isolation; `generate_title` creates a
scratch session and deletes it in a `finally` block (create-and-discard, so a
persistent scratch session doesn't accumulate every past title request as
history degrading future ones).

**Bug found later, fixed here — `StaleSessionError`, in two parts:**

*Part one — `rename_session` itself.* ADK's `append_event` does optimistic
concurrency checking, coarse-grained at the whole-session level: it compares
the loaded session object's storage revision against the current one, and
raises `StaleSessionError` if a concurrent writer advanced it first. Firing
the chat request and the title request concurrently (by design, from the
final title-generation design above) means two independent writers can
legitimately race on the same session row — confirmed live via a traceback
from a real deployment, and reproduced deterministically in the sandbox with
`asyncio.gather` of two concurrent writers to one session. Fixed with a
3-attempt reload-and-retry loop in `rename_session`, catching
`StaleSessionError` — which is exactly what the exception's own message asks
for ("reload the session before appending more events"), not a workaround.

*Part two — the symmetric risk on `/chat/stream`.* The race is symmetric:
either writer can lose it. ADK's own `Runner` has no retry for its normal
turn-appending path (only one narrow `except StaleSessionError` exists,
scoped to an unrelated optional compaction feature) — so `/chat/stream`
itself could just as easily crash mid-stream. There's no clean way to retry
there (some text may already be streamed to the client, and re-running
`run_async` would re-submit the user's message). Fixed by catching
`StaleSessionError` around the streaming loop and ending the stream
gracefully where it is, logged as a warning, instead of letting an unhandled
exception break the ASGI connection. Verified by mocking `run_async` to yield
partial text then raise mid-stream, confirming already-streamed text survives
and the generator exits cleanly rather than propagating.

### 8. Observability: logs and traces

**Requirement:** understand what FastAPI and ADK each provide out of the box,
and how they might conflict, before wiring anything up.

**Findings, from reading the actual installed packages rather than assuming:**
- **Logging:** ADK (`google_adk.*`) and Starlette/FastAPI are both
  well-behaved — no handlers of their own, defer to root config. Hypercorn is
  the exception: `hypercorn.error` (default `errorlog="-"`) attaches its own
  handler directly with `propagate=True`, so once the app configures a root
  handler, every Hypercorn-caught exception prints twice.
- **Tracing:** ADK unconditionally wraps agent invocations, tool calls, and
  model inference in spans via a **module-level** `tracer = trace.get_tracer(
  "gcp.vertex.agent")`, resolved at import time — safe regardless of import
  order because OTel's `get_tracer()` returns a `ProxyTracer` that resolves
  the real provider lazily, on first span, not at construction. ADK only
  calls `set_tracer_provider()` itself from its own `adk api_server` CLI dev
  server, which this project doesn't use — so there's no fight over the
  global (settable-once) `TracerProvider` singleton here. FastAPI has zero
  built-in tracing of its own.

**Strategy:** `app/observability.py`, called once from `main.py`'s lifespan
startup for logging (must run *after* Hypercorn's own bootstrap constructs its
loggers — proven by simulating that exact ordering and confirming the fix
survives it) and at module level for tracing (matches standard
`FastAPIInstrumentor` usage, no such ordering constraint). Dev default is
`ConsoleSpanExporter`; set `OTEL_EXPORTER_OTLP_ENDPOINT` to switch to a real
OTLP backend — deliberately the same env var ADK's own CLI already looks for.
Verified end-to-end using ADK's **actual** tracer object (not a stand-in): a
span it created shared the same `trace_id` as the surrounding FastAPI request
span with the correct `parent_id` — nesting works with zero manual context
propagation.

**Bug found immediately after, fixed here:** the OTLP branch referenced
`opentelemetry-exporter-otlp-proto-http` without it ever being declared as a
project dependency — only surfaced once `OTEL_EXPORTER_OTLP_ENDPOINT` was
actually set, since that's the only path that imports it, and the sandbox
testing never exercised that branch. Added the missing dependency; confirmed
against the exact scenario that broke (env var set, app boots clean).

### 9. Typed stream events, thought parts, and write-race errors

*(Commit A of the frontend-rebuild iteration: backend correctness only. The
vanilla UI still runs unchanged against it; the NDJSON wire, the `/api` prefix,
and the Solid port land in the commits after this one.)*

**Requirement:** the upcoming UI needs to render the agent's thinking, tool
activity, and grounding as distinct things — which the current stream can't
express, since `/chat/stream` emits undelimited `text/plain`. Before changing
the wire format, `core.py` had to start producing *typed* events instead of
bare text, and the correctness gaps §4 and §7 left behind had to close.

**Strategy — one part type, used everywhere:**
`TurnPart(kind: "text" | "thought", text)`, produced by a single `_parts()`
helper, replaces every `content.parts[0].text` read in the file. A streamed
delta and a stored transcript part carry the same payload, so they share the
type; `type StreamEvent = TurnPart` aliases it so tool calls and grounding can
widen that union later without touching `stream_message`'s signature.

`stream_message` now returns `AsyncIterator[StreamEvent]` — **the first change
to a `core.py` signature in the project's history**, and a deliberate one. The
§1 split's promise was that adapters absorb change, not that signatures never
move; a type that can only say "text" was the actual ceiling on every feature
this iteration exists to enable. `main.py` absorbs it for now by flattening
back to text, which keeps the HTTP wire byte-identical for the vanilla UI.

**Strategy — the streaming loop, rewritten around one invariant.** Confirmed
from ADK's installed `streaming_utils.py` and `StreamingMode.SSE`'s own
docstring: progressive SSE emits partial deltas and then, from the aggregator's
`close()`, a single non-partial event repeating all of them — *per LLM call*,
not per invocation. So the loop tracks `awaiting_aggregate`, yields partials as
they arrive, yields a non-partial event only when no partials preceded it, and
resets the flag on every non-partial. The old `yielded_any` flag was
invocation-scoped and would have dropped the second half of any turn a tool
call split in two.

**Strategy — write races become a core-domain error.** `ConcurrentUpdateError`
joins `SessionNotFoundError`; `core.py` translates ADK's `StaleSessionError`
into it at the boundary, so HTTP adapters handle a lost race without importing
`google.adk`. `main.py` maps it to **409** on rename and title, and ends the
stream where it is (§7's graceful end, preserved until NDJSON can carry a
typed error line instead).

**Strategy — thought summaries turned on.** Gemini thinks regardless;
`include_thoughts` only controls whether it returns the summary.
`root_agent` now sets it via `generate_content_config.thinking_config` —
verified against the installed ADK, which accepts it either there or on a
`BuiltInPlanner` and warns if both are set, making the planner unnecessary.
`title_agent` is deliberately left alone: nothing reads its reasoning.

**Bugs found while verifying, fixed here:**

- **The no-partials fallback was dead code, and wrong three ways over.** It sat
  *inside* the `async for` and inside the `if event.partial:` branch, guarded by
  `event.is_final_response()` — which is `False` for partial events by
  construction, so `final_event` was never assigned and the branch never ran.
  Had it run, it would have re-emitted on every subsequent iteration, and it
  read `parts[0].text` directly — reintroducing the exact thought-leak §4
  documents fixing. Replaced by the `awaiting_aggregate` invariant above.

- **§7's `rename_session` retry loop did not exist.** The code made one
  `append_event` attempt and logged the failure at ERROR with a copy-pasted
  "mid-stream" message, then returned normally — so `PATCH` answered 204 and
  `POST /title` returned a title that was never persisted. Now genuinely 3
  attempts, each *reloading the session first* (retrying with the same stale
  object fails identically every time), raising `ConcurrentUpdateError` when
  all three lose.

- **Two more `parts[0].text` reads survived §4's sweep**, in `generate_title`
  and `send_message`. Both now go through `_answer_text()`, which also changed
  behavior: it concatenates *all* non-thought parts rather than returning the
  first. A reply split across several text parts previously lost everything
  after the first one.

- **`StreamingMode` was imported from a private path**
  (`google.adk.agents._streaming_mode`). It is re-exported from
  `google.adk.agents.run_config` — but *not* from `google.adk.agents`, which is
  the plausible-looking guess.

- **Pyright was checking nothing, and not for the documented reason.** The
  config read `typeCheckingMode = "basic"  # ...comment...include = ["src"]` —
  the `include` key was swallowed into the trailing comment on the same line,
  so it never parsed at all. Fixed by putting it on its own line, pointed at
  `app` rather than the nonexistent `src`.

**README corrections (the docs had drifted from the code):** §4's claim that
`_answer_text()` was used in "its no-partials fallback branch" described a
branch that could never execute; §7's 3-attempt retry loop was described but
never written; §7's claim that new sessions are created with
`state={"title": "Untitled"}` is false — `create_session` sets no state, and
`maybe_generate_title`'s idempotency check tests whether a title exists at all,
not whether it still equals `"Untitled"`. The check is still race-free, for a
slightly different reason than the one recorded. Fixed in place above.

**Verified** with a scripted fake agent driven through the real `Runner` +
`DatabaseSessionService`, in the style of §4 and §7: partials-then-aggregate
yields each delta exactly once; a lone aggregate is still delivered; two LLM
calls in one turn each de-duplicate independently; thoughts survive into the
transcript as separate parts; a `StaleSessionError` on the model-turn append
surfaces as `ConcurrentUpdateError` *after* the already-streamed text
(discovered en route: failing the *first* append tests nothing, because the
Runner persists the user message before the agent ever runs); rename succeeds
on the third attempt and gives up on the fourth without writing. Plus HTTP-level
tests asserting the wire is unchanged — thoughts excluded from both the
transcript and the stream, and 409 on a rename race.


### 10. NDJSON wire, /api namespace, and CSRF defense

*(Commit B of the frontend-rebuild iteration. The vanilla UI stops working
here, deliberately — it calls unprefixed paths and reads bare text. Commit C
brings up the build pipeline; commit D ports the UI and deletes `app/static/`.)*

**Requirement:** three things the frontend rebuild needs from the backend
before any framework code exists — a wire format that can distinguish thinking
from answers and failure from completion, a path namespace a dev-server proxy
can forward wholesale, and a CSRF story that doesn't depend on the frontend and
backend sharing an origin by accident.

**Design — the cross-origin problem, refused rather than solved.** A build step
does not require two origins. Vite proxies `/api` to Hypercorn server-side, so
the browser only ever talks to one port in dev; in production FastAPI serves the
build. One origin in both environments means no CORS middleware, no
`credentials: 'include'`, and no SameSite change — the entire category of
complication this iteration was supposed to incur, declined.

Worth recording because the original framing of this iteration got it backwards:
SameSite compares *sites* — scheme plus registrable domain — and ports are not
part of a site. `localhost:5173` → `localhost:8000` is same-site, and Lax
cookies flow across it regardless. Two ports would have broken CORS (origins
*do* include ports), not cookies. The one genuine trap there is mixing
`localhost` and `127.0.0.1`, which *is* cross-site and drops the cookie silently.

**Design — the wire.** `application/x-ndjson`, one JSON object per line:

```
{"type":"thought","delta":"User wants a one-line"}
{"type":"text","delta":"Paris is the capital."}
{"type":"done"}
```

Three rules carry the weight. Every server-controlled ending emits exactly one
`done` or `error`, so a stream ending with **neither** means truncation — the
one thing `text/plain` could never distinguish from success. Error codes are a
closed set (`stale_session`, `internal`) and exception text never reaches the
wire. Unknown `type` values are the client's problem to ignore, which makes
`tool_call` and `grounding` purely additive later; they are *not* emitted now,
because there is no tool to test them against and untested emitters are how §8's
OTLP bug happened.

Failures split by timing rather than kind: anything detectable before headers go
out (401, 403, a missing session) stays an HTTP status code, and the pre-stream
`session_exists` check survives precisely because it is the last moment that's
still possible. After the first chunk, 200 is committed and errors can only be
in-band.

Serialization uses `match` over the event union (structural pattern matching,
the idiom) with a `case _` that logs loudly — `StreamEvent` is explicitly built
to widen, and a new member silently vanishing from the stream would be
near-undebuggable from the client. `json.dumps` escapes embedded newlines, so
splitting on `\n` downstream is unambiguous; verified with a delta containing a
literal newline.

**Design — `/api` namespace.** One `APIRouter(prefix="/api")` carries every
route including the two fastapi-users routers, included at the bottom of the
module (`include_router` copies routes *at call time*, so anything registered
afterward silently wouldn't exist). One proxy rule, and no UI route can ever
collide with an API path — `/sessions/{id}` would have, today.

The catch-all static mount undercuts that on its own: an unmatched `/api/...`
path falls through and answers an API call with HTML. Fixed with a bare ASGI
404 mounted at `/api` between the router and the static mount. Deliberately a
Mount and not a catch-all *route*, so it stays out of the OpenAPI schema commit
C generates TypeScript types from. Accepted cost: under `/api`, a wrong method
on a real path now returns 404 rather than 405.

**Design — CSRF, because Lax alone isn't enough even same-origin.** Three gaps
survive SameSite=Lax: same-site attackers (every other dev server on localhost
is same-site with this one), routes whose bodies make them CORS-simple — no
preflight, cookie attached, side effect lands — and login CSRF, which needs no
cookie at all and so is unaffected by cookie policy entirely.

`app/security.py` compares `Origin` against `Host` on unsafe methods and 403s on
mismatch. No tokens, no state, ~30 lines, and it closes all three. Chosen over a
double-submit token (needs a token endpoint, a cookie, and frontend plumbing)
and over per-route checks (the point is that it can't be forgotten on a new
route). Absent `Origin` is allowed: only browsers send it, and only browsers can
be tricked into attaching someone else's cookie.

Written as **pure ASGI rather than `BaseHTTPMiddleware`**, which buffers through
an anyio stream and would sit between the client and a streaming response.
Confirmed on a real socket: NDJSON lines arrive 400ms apart under Hypercorn with
the middleware installed, not batched at the end.

`cookie_secure` now reads `COOKIE_SECURE` from the environment and **defaults to
true** — the dev-only value has to be opted into, so it can't reach production by
being forgotten. `cookie_samesite="lax"` is stated explicitly; it was already
the default, so this is documentation rather than a behavior change.

**Findings from verification:**

- **`urlsplit` on bytes returns bytes.** The first draft called `.encode()` on
  an already-bytes netloc, which meant the middleware raised `AttributeError` on
  *every* cross-origin request instead of returning 403 — caught only because a
  test asserted the status code rather than merely that the request failed.
- **Duplicate `Origin` or `Host` headers now reject outright.** A dict
  comprehension over `scope["headers"]` silently keeps the last value, which
  makes the check's verdict depend on which of two conflicting values a proxy
  happened to append. Ambiguity is not a thing to resolve by coin-flip here.
- **HTTP/2 has no `Host` header**, only `:authority`. Confirmed from Hypercorn's
  `filter_pseudo_headers` that it synthesizes `host` from `:authority` for h2
  and h3, so a header comparison is protocol-version-agnostic. Worth checking
  rather than assuming: a security control that 403s everything under HTTP/2
  would fail closed, loudly, in production only.
- **`changeOrigin: true` on the Vite proxy would break this**, and the failure
  mode is now pinned down: it rewrites `Host` to the backend's, so every unsafe
  request arrives with `Origin: localhost:5173` and `Host: 127.0.0.1:8000` and
  gets a 403. Reproduced both header shapes directly — the correct one passes,
  the rewritten one 403s. Most copy-pasted proxy configs set it to `true`.
- **`CookieTransport` already defaults to `secure=True` and `samesite="lax"`.**
  So the previous `cookie_secure=False` wasn't a missing setting, it was an
  explicit downgrade of a safe default — which is exactly the kind of thing a
  "flip this before prod" comment fails to catch.

**Also changed:** `TranscriptResponse` now returns `parts` rather than a
flattened `text`, matching what the stream emits. Not in the original commit-B
plan, but a reloaded session has to render identically to a live one, and doing
it here keeps the wire changes in the commit named for them rather than
reopening the schema in commit D.

**Verified** with 25 assertions against the real ASGI app plus a live Hypercorn
run: routes moved and old paths gone; unmatched `/api` paths answer JSON, not
HTML; deltas serialize with a terminal `done`; a lost write race ends with
`error/stale_session` and no `done`; a generic exception yields `internal` with
no exception text leaked; embedded newlines don't split a line; cross-origin
POST/DELETE 403 while GET passes and `Origin: null` is rejected; a same-site
*different-port* origin is rejected (the case Lax would have allowed);
`COOKIE_SECURE` unset produces `Secure`, `false` omits it; and NDJSON streams
incrementally over a real socket with `Transfer-Encoding: chunked`.


### 11. Build pipeline: Vite + Solid, one origin in both environments

*(Commit C of the frontend-rebuild iteration. The pipeline runs end to end here
against a placeholder page; commit D ports the UI and deletes `app/static/`.)*

**Requirement:** a component framework with a build step, without acquiring the
cross-origin problems a build step is assumed to bring, and without a second
server competing with FastAPI.

**Framework — Solid 1.9, for the boring reasons.** Fine-grained reactivity is
*not* the reason. At this scale a token stream is tens of updates per second
into a few hundred nodes; React re-rendering one bubble per chunk would be fine.
Choosing Solid for performance here would be choosing on vibes. The real
reasons: existing proficiency, so this iteration's learning budget goes to the
pipeline rather than a framework; and store path setters
(`setMessages(i, "parts", j, "text", t => t + delta)`) mapping directly onto
accumulating streamed deltas into nested state, which is the exact shape the
thinking, tool, and grounding panels need.

React's genuine advantage — streaming-markdown renderers and chat UI kits are
React-first — is a real cost, accepted knowingly, payable the day markdown
rendering lands.

**Version choices, all deliberately conservative:**
- **Solid 1.9.15, not 2.0.** 2.0 is at rc.8, and removes `createResource`,
  `batch`, `on`, `createComputed`, and `produce` — every one of which existing
  1.x proficiency leans on. Migration is backlogged until the router and
  primitives go GA. The scaffolded `^1.9.15` already excludes 2.0, so no tighter
  pin was warranted; the earlier worry that the template might hand over an RC
  was unfounded, since `latest` is still 1.x.
- **No SolidStart.** It's a meta-framework with its own server — a second
  backend competing with FastAPI for the same job. A plain Vite SPA instead.
- **Even so, `createResource` is avoided in application code** (the placeholder
  uses `createSignal` + `onMount`), because the 2.0 migration gets smaller for
  free if the removed primitives were never adopted.

**Design — one origin in dev *and* prod, so the CORS work never happens.** Vite
proxies `/api` to Hypercorn server-side; the browser only ever talks to
`:5173`. In production FastAPI serves `frontend/dist`. Same-origin both ways
means no CORS middleware, no `credentials: "include"`, and no SameSite change —
the entire category of complication this iteration was expected to incur,
declined rather than solved.

Two comments in `vite.config.ts` are load-bearing. The target is `127.0.0.1`,
not `localhost`, because Node may resolve `localhost` to `::1` while Hypercorn
binds IPv4, and the failure is a silent `ECONNREFUSED`. And `changeOrigin` must
stay **false**: it rewrites `Host` to the target's, which makes every unsafe
request arrive as `Origin: localhost:5173` against `Host: 127.0.0.1:8000` and
collect a 403 from §10's `SameOriginOnly`. Most copy-pasted proxy configs set it
to `true`.

**Design — static serving.** `FRONTEND_DIST` resolves from `__file__` rather
than the working directory, so `hypercorn app.main:app` behaves identically from
anywhere — the old `directory="app/static"` silently depended on being launched
from the repo root. The mount is conditional on `index.html` existing, with the
"API only" warning logged from inside `lifespan` rather than at module level,
since `configure_logging()` hasn't run at import time.

`HashedAssetFiles` overrides `file_response` to send
`max-age=31536000, immutable` for anything under `assets/` and `no-cache` for
everything else. Vite fingerprints asset filenames, so they're immutable by
construction; `index.html` names them and is *not* hashed, so caching it even
briefly leaves browsers requesting chunks the last deploy deleted.

**Design — generated types.** `npm run gen:api` dumps FastAPI's schema by
*importing* the app rather than hitting a running server (a codegen step that
needs a live backend is a codegen step that breaks on CI), then runs
`openapi-typescript` into a committed `src/api/schema.d.ts`. A renamed Pydantic
field now fails `tsc` instead of silently rendering `undefined`.

**Findings from building it:**

- **The Vite template ships with `strict` unset**, so TypeScript defaults to
  non-strict and the generated API types would have been close to ornamental.
  Enabled in both `tsconfig.app.json` and `tsconfig.node.json`. The payoff shows
  up immediately: `PartOut.kind` generates as `"text" | "thought"`, a real
  discriminant rather than `string`.
- **`openapi-typescript` and the template's TypeScript version don't coexist.**
  The template pins `typescript ~6.0.2`; `openapi-typescript@7.13.0` peers on
  `^5.x`, and there is no TS-6-compatible release on any dist-tag. Resolved by
  pinning `typescript ~5.9.0` rather than reaching for `--legacy-peer-deps`,
  which would have "resolved" it by lying. Nothing here uses a TS 6 feature —
  `erasableSyntaxOnly` and `allowArbitraryExtensions` are both 5.x. Backlogged:
  unpin when upstream supports TS 6.
- **OpenAPI cannot describe the NDJSON stream.** `POST /api/chat/stream`
  generates as `application/json: unknown`, because `StreamingResponse` bodies
  aren't in the schema. This was predicted, and is now confirmed rather than
  assumed: the `StreamLine` union stays hand-maintained, and it is the one place
  where frontend and backend can drift silently.
- **`html=True` is not an SPA fallback**, contradicting the comment that sat in
  `main.py` since §2. Starlette serves `index.html` for *directory* paths only;
  an unmatched non-directory path returns 404 — verified directly against a
  running server (`/some/spa/route` → 404). Harmless today because there's no
  client-side routing; the comment is now accurate, and the first router added
  will need a real fallback.

**Verified** against live servers in both modes rather than by inspection. Prod:
Hypercorn alone serves the build, `index.html` returns `no-cache`, a hashed
asset returns `immutable`, `/api/health` answers JSON, `/api/bogus` answers JSON
404 rather than HTML. Dev: Vite on 5173 and Hypercorn on 8000, with `/api/health`
proxied correctly, NDJSON lines arriving 400 ms apart through the proxy (so
nothing buffers the stream), a same-origin POST returning 200, and a forged
`Origin` still collecting a 403 — proving the CSRF check survives proxying with
`changeOrigin: false`.



### 12. Solid UI: parity port, visible thinking, and streams that outlive the view

*(Commit D, closing the frontend-rebuild iteration. `app/static/` is deleted
here.)*

**Requirement:** reach feature parity with the vanilla UI on the new pipeline,
render the agent's thinking as a first-class thing rather than as text mixed
into the answer, and give the app the state model the deferred features (tool
calls, grounding, debug panels) will attach to.

**Design — three layers, one direction.** `api/` knows about HTTP and nothing
else, `state/` knows about policy and nothing about the DOM, components read
state and call actions. The payoff is concrete rather than architectural
theatre: `streamChat()` is the only function in the app that touches a response
body, so the next wire-format change reaches exactly one file per side.

**Design — one fetch wrapper, one 401 handler.** `apiFetch` adds the `/api`
prefix and turns *any* 401 into `auth = "anon"` app-wide, replacing the vanilla
app's per-call status checks. This is only safe because fastapi-users answers
bad credentials with **400**, not 401 — so a failed login surfaces in the login
form instead of being swallowed as "your session expired". A global handler
built on the wrong status code would have silently converted every typo into a
logout.

**Design — the message model is parts from day one.**
`Message = { role, parts: { kind, text }[] }`, matching both the NDJSON stream
and `TranscriptResponse`, so a reloaded session renders identically to a live
one. `applyLine()` is the whole protocol reduced into state in one switch:
deltas merge into the trailing part when the kind matches and open a new part
when it changes, `done` goes idle, `error` records a code, and unknown types are
ignored by contract — which is what makes `tool_call` and `grounding` additive
later rather than breaking changes.

Thought parts render in a collapsed `<details>`. Present on demand, out of the
way by default, and structurally incapable of being mistaken for the answer —
the bug §4 spent a day chasing is now unrepresentable rather than merely fixed.

**Design — streams outlive the view that started them.** A per-session
`AbortController` registry, with a deliberately narrow abort policy: switching
sessions does **not** abort. Aborting would disconnect the client mid-turn,
Starlette would cancel the generator, and ADK would die mid-run — leaving the
user's message persisted with no reply, which is a worse outcome than a reply
the user didn't watch arrive. Only deleting the session being streamed into, or
logging out, aborts. `selectSession` skips the transcript refetch while a
session is streaming, because the server's transcript doesn't yet contain the
in-flight turn and would clobber live state with a stale version of itself.

**Design — Solid 2.0 avoidance, applied from the first file.** No
`createResource`, `batch`, `on`, `createComputed`, or `produce` anywhere.
`sendMessage` pushes the user turn and the empty assistant turn with a path
setter rather than the `produce` draft that would read more naturally, on the
grounds that the migration is smaller if the removed primitives were never
adopted. The first draft of `chats.ts` used `produce` anyway; caught in review
against the policy, not by the compiler.

**Ported unchanged, because they were right:** resume-most-recent on entry,
self-heal by creating a fresh session when a listed session 404s, "new chat"
deliberately bypassing the resume policy, delete-current re-resolving through
the same policy, patching the sidebar title in place from the title response
rather than refetching, and rename committing on blur with Enter delegating to
blur and Escape cancelling.

That last one needed care. `<Show>` unmounts the input on Escape, and removing a
focused element doesn't reliably fire `blur` across browsers — so cancellation
is a plain instance variable, not a signal, read synchronously inside the blur
handler it's racing. Nothing renders from it, so a signal would only buy
re-renders nobody wants.

**Two things the port fixed for free:**
- The composer disables the entire form while streaming, closing the
  double-submit gap the vanilla Send button left open (§6).
- The stylesheet lost its `[hidden]` rules and the `#chat-view:not([hidden])`
  workaround. That hack existed because an ID selector's `display: flex`
  outranks `[hidden]`'s `display: none` regardless of rule order; `<Show>`
  unmounts rather than hides, so the entire specificity fight is gone.

**Bug found in the vanilla app while porting it:** §7 documents the title
request and the chat request as "two independent, concurrent `fetch()` calls",
and the whole `StaleSessionError` retry loop exists to absorb the write race
between them. The code didn't do that. The title `fetch` sat *after* the
streaming `try/finally`, so it only started once the stream had fully
completed — strictly sequential, and the documented race was therefore mostly
unreachable from this client. Ported as designed rather than as written: the
title request now fires **before** the stream is awaited. Which means §7's retry
loop stops being insurance against a hypothetical and starts earning its keep.

**Finding — `erasableSyntaxOnly` bans constructor parameter properties.** The
Vite template enables it, and `HttpError(readonly status: number)` — ordinary
TypeScript, and the form every tutorial uses — fails to compile, because it's
TS syntax that emits runtime code. Rewritten with explicit field declarations.
Worth knowing before it bites again on enums and namespaces, which the flag also
rejects.

**Verified.** Fourteen assertions against the real `streamChat` and the real
store, driven through mocked response bodies chunked adversarially: a body
delivered one byte at a time parses identically to one delivered whole; a 4-byte
emoji split across a chunk boundary survives (the case a hand-rolled
`TextDecoder` turns into U+FFFD); an unterminated final line is flushed; blank
lines are skipped; same-kind deltas merge while a kind change opens a new part;
`done` goes idle, `error` records its code with prior text intact, and a stream
ending with *neither* is marked interrupted; an unknown line type is ignored
without derailing completion.

Then the full sequence the components perform, against a live Hypercorn running
the real ADK `Runner` with a scripted agent: register, login, list, create,
title, stream (thought and text deltas, terminal `done`), transcript — returning
the thought part alongside the answer — rename, list, delete, 404 on the deleted
session's transcript (the self-heal trigger), logout, and 401 afterwards (the
drop-to-anon trigger). The production build is served by FastAPI and loads.

**Not verified, and worth saying plainly:** no browser ran this code. The
sandbox has no headless browser, so component rendering, the auto-scroll effect,
and the rename blur/Escape race are reasoned-through rather than observed. They
are the first things to check by hand, and the first things the deferred test
suite should cover.


### 13. One writer per session

*(Bug fix on top of §12, not a new iteration.)*

**Symptom:** submitting the first message in a new session returned
`{"type":"error","code":"stale_session"}`, and the *next* message came back
answering both messages at once.

**Root cause:** §12 moved the title request to fire before the stream is
awaited, on the grounds that §7 documents the two calls as concurrent and the
vanilla code ran them sequentially. The sequencing was load-bearing. The README
was the wrong half.

ADK's optimistic concurrency is per session, and the Runner holds the session
snapshot it loaded at the start of a run:

1. The Runner appends the user's message and keeps its snapshot.
2. The title request calls `rename_session`, which **reloads** and appends the
   title. It wins precisely because it reloads.
3. The Runner finishes and appends the model's turn against its now-stale
   snapshot. `StaleSessionError` → `ConcurrentUpdateError` → `error` line.
4. The assistant turn is never persisted. The user's message is.
5. The next turn replays session events as history, so the model receives two
   consecutive user turns and answers both.

The retry loop was on the wrong side of the race. `rename_session` retries and
always wins; the stream cannot retry, because the Runner owns its own appends
and the tokens are already on the wire. §7 armored the only participant that was
never going to lose.

**Fix — separate the slow part from the conflicting part.** Generation was never
the problem; the *write* was. `/chat/stream` now starts `generate_title()` as a
task before returning the response, so the title model and the chat model still
overlap, and writes the result only after the run has finished appending. The
title reaches the client as a new NDJSON line:

```
{"type":"text","delta":"Paris is the capital."}
{"type":"title","title":"France questions"}
{"type":"done"}
```

It carries `title`, not `delta`, because a name replaces rather than
accumulates, and it arrives before `done`, so "exactly one terminal line" still
holds. This is the first use of the forward-compatibility rule §10 designed:
older clients ignore the line rather than breaking on it.

**Deleted:** `POST /api/sessions/{id}/title` and its models,
`core.maybe_generate_title`, `core.session_exists`, and the frontend's
`api.generateTitle`. Read-check-generate-write was `maybe_generate_title`'s
entire shape, and splitting the generate from the write is the whole fix, so
nothing coherent was left of it.

**Added:** `core.session_title()`, which replaces `session_exists`. The stream
route needs to know both that the session is real — the last moment a 404 can
still be a status code rather than an in-band error — and whether this turn
should generate a title. One read answers both questions.

**Two details that are easy to get wrong:**

- A failed title must **not** emit `error`. The reply is already persisted, so
  reporting a failed name as a failed turn would recreate the display/storage
  disagreement this fix exists to remove. The title write sits in its own nested
  `try`, logs, and falls through to `done`.
- The task must be cancelled in a `finally`. On a client disconnect or a failed
  run, nobody awaits it, and asyncio surfaces the unretrieved exception later
  and somewhere unrelated.

**Frontend:** `sendMessage` no longer knows what a first turn is — the server
decides. `applyLine` takes `onTitle` as a parameter rather than importing
`applyTitle`, since `sessions.ts` already imports `chats.ts` and reaching back
would close the cycle. And on a `stale_session` line the transcript is now
refetched: the reply on screen was never stored, and leaving it there is how the
UI and the database end up disagreeing about what happened.

**Verified** against the original repro on a live server with a scripted agent
slow enough to hold the race window open: first turn emits `title` then `done`,
a later turn emits no title line at all, and the transcript alternates
`user, assistant, user, assistant` where it previously read
`user, user, assistant`. A title agent that raises still produces a successful
turn with the reply persisted and one logged failure. A client that hangs up
mid-stream leaves no orphaned-task warning. Plus eight frontend assertions: the
title line reaches the sidebar without being rendered into the transcript or
terminating the stream, and a `stale_session` error resyncs the display to what
the server actually stored while keeping the error state.

**Unrelated, found while diagnosing:** the Ctrl+C traceback on Windows is
Hypercorn's, not ours — every frame is in its supervisor process or CPython's
`multiprocessing`. Ctrl+C interrupts `WaitForMultipleObjects`, and PEP 475's
automatic EINTR retry doesn't cover `_winapi`, so `wait()` raises
`InterruptedError` and Hypercorn doesn't catch it. The parent then dies without
joining its workers, which can orphan a worker still holding the port. Running
with `--workers 0` skips the multiprocessing supervisor entirely; it can't be
combined with `--reload`, so keeping reload means driving restarts externally
(e.g. `watchfiles`).


### 14. Model failures are failures

*(Bug fix on top of §13.)*

**Symptom:** the third message in a session produced no reply and no error. On
reload the message was there with nothing after it. The next message worked.

**Root cause:** an ADK `Event` *is* an `LlmResponse`, so it carries
`error_code`, `error_message`, and `finish_reason` alongside content. When a
response is truncated, blocked, or filtered, the aggregator returns exactly
that — and `content=None`:

```python
if finish_reason and finish_reason != types.FinishReason.STOP:
    error_code = finish_reason
...
content = types.ModelContent(parts=parts) if parts else None
```

`_parts()` reads `content`, gets `None`, returns `[]`. `stream_message` yields
nothing, `_ndjson` reaches the end of the loop without an exception, and emits
`done`. **We told the client the turn succeeded**, logged nothing, and discarded
the only record of what went wrong. The Runner had already persisted the user's
message, so the transcript kept an orphaned user turn — and the *next* message
got answered together with the failed one, which reads as a working app.

That is §13's bug wearing a different hat: one failure mode was handled,
`ConcurrentUpdateError`, and the code quietly assumed it was the only one.

**Fix:** `ModelError` joins `SessionNotFoundError` and `ConcurrentUpdateError`.
`stream_message` and `send_message` both check `event.error_code`, and
`_ndjson` maps it to `{"type":"error","code":"model"}` — logging the finish
reason at ERROR, because the client only ever sees the closed code set and the
log is now the sole record of the cause.

The failure is **recorded during the loop and raised after it**, which matters
for two reasons. Text already streamed stays streamed: a reply truncated
mid-sentence reaches the user followed by an error line, rather than vanishing.
And raising from inside the `async for` tears down ADK's async generator
mid-iteration, which unwinds its OpenTelemetry context managers in the wrong
context — the first version of this fix produced five `Failed to detach context`
tracebacks per failed turn, drowning the one log line the fix existed to
produce. Letting the generator drain costs nothing, since an error event ends
the invocation anyway.

**Frontend:** `"model"` joins the error union, and `Transcript` now picks its
message from `errorCode` rather than showing one generic line for every failure.
`errorCode` had been stored since §12 and displayed by nobody, which is its own
small lesson — the codes mean different things to a user: retry, reload, or give
up.

**Why the third message?** Unknown, and that was the point: nothing recorded it.
The pattern rules out anything persistent, since the fourth message succeeded
against a *larger* history — so not thought signatures, not corrupted history.
The leading suspect is `MAX_TOKENS`: §9 enabled `include_thoughts`, thinking
tokens count against the output limit, and thinking grows with conversation
length. Safety blocks and transient 5xxs produce an identical shape. The server
log now names which.

**Still open:** a failed turn leaves the user's message in history with no reply,
so the next message is answered together with it. Writing a placeholder
assistant event would keep history alternating, at the cost of the model seeing
a record of its own failure in context. Deliberate decision, not yet made.

**Verified** with a scripted agent whose third turn returns ADK's exact failure
shape: before, four turns produced `text, done / text, done / done / text, done`
and a transcript reading `user, assistant, user, assistant, user, user,
assistant`. After, the third turn emits `error/model`, the log names
`MAX_TOKENS: exceeded the output token limit`, and no OpenTelemetry noise
appears. Also verified directly against `core`: a truncated response yields its
partial text *then* raises; a response with no content at all raises the same
way; a clean turn raises nothing; and `/chat`'s non-streaming path is covered
too.


## File Layout

```
adk-fastapi-demo/
├── pyproject.toml
└── app/
    ├── agent.py            # root_agent, title_agent
    ├── core.py             # all ADK logic (session CRUD, streaming, titles, transcript)
    ├── db.py               # SQLAlchemy engine/tables for fastapi-users
    ├── users.py            # fastapi-users wiring (DatabaseStrategy, cookie transport)
    ├── schemas.py          # UserRead / UserCreate
    ├── main.py             # FastAPI app, routes, lifespan (table setup + observability)
    ├── observability.py    # logging + tracing setup
    ├── cli.py              # standalone REPL adapter over core.py
    └── static/
        ├── index.html      # auth view + chat view (sidebar + chat pane)
        ├── style.css
        └── app.js          # vanilla JS, no framework
```

## Open Items

- Session rename UI, multi-session picker, and LLM-generated titles are fully
  implemented as of §7.
- The "Send" button isn't disabled during streaming (§6) — cosmetic, not yet
  fixed.
- CLI (`app/cli.py`) has no titling or streaming support — accepted as a
  permanent gap, not a bug.
- Email verification / password reset routes exist in `fastapi-users` but are
  not mounted — deferred, not yet requested.


# How to build & run

Nothing here is optional except which of the two run modes you pick, and `.env` is the step that will bite you, since it's gitignored and the app boots without it.

## 0. Prerequisites

```bash
node --version   # need ^20.19 or >=22.12 — Vite 8 refuses older
uv --version
```

## 1. Clone and install

```bash
git clone <repo> && cd <repo>
uv sync
cd frontend && npm install && cd ..
```

## 2. Create `.env` (gitignored — it does not come with the clone)

```bash
cat > .env <<'EOF'
GOOGLE_API_KEY=<your key>
AUTH_SECRET=<any long random string>
COOKIE_SECURE=false
# DATABASE_URL defaults to sqlite+aiosqlite:///./database.db
EOF
```

`COOKIE_SECURE` defaults to **true**. Omit that line and dev login fails silently over HTTP — the browser accepts the `Set-Cookie` and then refuses to send it back, so you get a clean 401 on the next request with nothing in the logs.

## 3. Generate API types

```bash
cd frontend && npm run gen:api
```

Needed only if `src/api/schema.d.ts` is missing or the backend schema moved; `tsc` fails without it. Requires `uv` on PATH, since the script shells out to `uv run python`.

## 4a. Dev — two terminals

```bash
# terminal 1
uv run hypercorn app.main:app --bind 127.0.0.1:8000 --reload

# terminal 2
cd frontend && npm run dev
```

Open **http://localhost:5173**. Do not open `127.0.0.1:5173` — `localhost` and `127.0.0.1` are different sites, so the session cookie won't follow you between them.

The backend logs `no frontend build at .../frontend/dist; serving API only` on startup. In dev that's correct and expected: Vite serves the UI and proxies `/api` through.

## 4b. Prod-shaped — one process

```bash
cd frontend && npm run build && cd ..
uv run hypercorn app.main:app --bind 0.0.0.0:8000
```

Open **http://localhost:8000**. Build *before* starting: the static mount is decided at import time, so a server started against an empty `dist/` stays API-only until you restart it.

Behind HTTPS, drop `COOKIE_SECURE=false`.

## 5. Verify

```bash
curl -s localhost:8000/api/health     # {"status":"pass"}
curl -s localhost:8000/api/bogus      # {"detail":"not found"} — JSON, not HTML
```

Then register an account in the UI and send one message. You should see a collapsed "thinking" block above the reply; if the model returns no thought summary, that's flash-lite's thinking budget, not a bug.

The database file is created on first boot. Delete `database.db` to start clean — it holds both your users and your chat sessions.

A gitignored file is a file you will forget exists precisely once per machine.



# Backlog
- Email verification of registrations
- Password reset functionality
- Superuser: Optionally view all users and access their sessions (as read-only)