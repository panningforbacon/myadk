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

# Backlog
- Rebuild front-end as a component'ized and reactive app (React or SolidJS)
- Email verification of registrations
- Password reset functionality
- Superuser: Optionally view all users and access their sessions (as read-only)