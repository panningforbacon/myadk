# My first Google-ADK + FastAPI app

A minimal scaffold for learning how Google ADK, FastAPI, and `fastapi-users`
fit together: `Agent` + `SessionService` → `Runner`, run behind either an
HTTP API + browser front end, or a local CLI REPL.

## Architecture

```
app/
  agent.py    # root_agent: the one LlmAgent, model + instruction only
  core.py     # all ADK-facing logic: Runner, InMemorySessionService, and a
              # plain async contract (create_session, list_sessions,
              # delete_session, get_transcript, send_message) that raises
              # SessionNotFoundError on a bad id. No HTTP, no auth, no CLI
              # concerns leak in here.
  db.py       # SQLAlchemy models + engine for fastapi-users (SQLite)
  users.py    # fastapi-users wiring: UserManager, cookie+DB-session auth backend
  schemas.py  # UserRead / UserCreate pydantic schemas for fastapi-users
  main.py     # HTTP adapter over core.py + fastapi-users routers; serves the
              # static front end
  cli.py      # REPL adapter over core.py, single fixed local user, no auth
  static/     # the browser front end: index.html + app.js + style.css,
              # no framework, no build step, served by FastAPI itself
```

`main.py` and `cli.py` both call into `core.py` and never touch ADK directly.
`user_id` used to be a client-supplied argument; it's now `str(user.id)`,
resolved from an authenticated cookie session (see **Auth** below) — a
client can no longer just claim to be anyone.

## Setup

```shell
uv sync
```

Environment variables (put these in `.env`; `python-dotenv` loads it):

| Variable | Purpose | Required |
|---|---|---|
| `GOOGLE_API_KEY` | Gemini API key (AI Studio), used by `root_agent` | Yes |
| `AUTH_SECRET` | Signs password-reset/verification tokens (not the session token itself — see **Auth**) | No — has an insecure dev fallback; override before deploying anywhere but a laptop |

## Usage: HTTP server + browser front end

```shell
uv run hypercorn app.main:app --bind 0.0.0.0:8000
```

Open `http://localhost:8000` — that's the static front end (`app/static/index.html`),
served by FastAPI itself so cookie auth stays same-origin (no CORS to configure).
Register an account, log in, and you're in a chat view: an empty session shows
just the input box, a resumed non-empty session replays its prior turns first.

### Routes

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Create an account (email + password) |
| POST | `/auth/login` | Form-encoded (`username`, `password`, OAuth2 password flow shape) — sets a cookie |
| POST | `/auth/logout` | Deletes the server-side session row; the cookie the client held becomes worthless immediately |
| POST | `/sessions` | Create a new ADK session for the authenticated user |
| GET | `/sessions` | List the authenticated user's sessions |
| DELETE | `/sessions/{session_id}` | 404s if it's not this user's session (or doesn't exist) |
| GET | `/sessions/{session_id}/messages` | Transcript: past turns, filtered the same way `/chat` filters a live response (user messages plus only `is_final_response()` agent events — tool calls and streaming partials excluded) |
| POST | `/chat` | `{session_id, message}` → `{response}` |

curl needs a cookie jar to exercise the authenticated routes:

```shell
curl -c cookies.txt -X POST http://localhost:8000/auth/register \
  -H 'content-type: application/json' -d '{"email":"you@example.com","password":"hunter2pass"}'
curl -c cookies.txt -b cookies.txt -X POST http://localhost:8000/auth/login \
  -d 'username=you@example.com&password=hunter2pass'
curl -b cookies.txt -X POST http://localhost:8000/sessions
curl -b cookies.txt -X POST http://localhost:8000/chat \
  -H 'content-type: application/json' \
  -d '{"session_id":"[SESSION_ID]","message":"How did the days of the week get their names?"}'
```

## Auth

`fastapi-users`, with a **server-side session**, not a JWT: login inserts a
row into a SQLite `access_token` table and puts only that row's random token
in an `httponly` cookie — nothing about identity is encoded in what the
client holds. Logout deletes the row, which is what makes logout actually
revoke access (a stateless JWT can't do this without a separate revocation
list). `users.db` (SQLite) is created on first run; it holds the `user` and
`access_token` tables and is safe to delete to reset all accounts.

Not wired up: email verification and password reset. Both routers ship in
`fastapi-users` (`get_verify_router`, `get_reset_password_router`) but aren't
mounted in `main.py` yet.

## Usage: CLI

For local, single-user, single-session use — no HTTP, no auth involved:

```shell
uv run adk-chat
```

```
session 3f9e2b7a-... -- type 'exit' to quit
> How did the days of the week get their names?
They're named after Sun, Moon, and five classical planets/gods.
> exit
```

## Known limitations

- **`InMemorySessionService` is process-local.** The CLI and the HTTP server
  each build their own store at startup — a conversation started in one is
  invisible to the other. A server restart (or running more than one worker
  process) also drops every session that existed only in that process's
  memory; the front end treats a since-vanished session as a signal to
  silently start a fresh one rather than getting stuck (see `showChatFor` in
  `app.js`).
- **No session picker yet.** The front end resumes whichever of the
  authenticated user's sessions was most recently updated; there's no UI yet
  to list, rename, or switch between multiple sessions.
- **`[hidden]` vs `form { display: flex }`:** worth knowing if you touch
  `style.css` — a bare type selector for `form` is author-origin CSS, which
  beats the browser's built-in `[hidden] { display: none }` (user-agent
  origin) regardless of specificity. `style.css` now declares its own
  `[hidden] { display: none; }` near the top to win back that rule on plain
  specificity; don't remove it without checking `form`/`main`/etc. for
  competing `display` declarations first.

## Planned next

- Streaming responses (ADK's `run_async` already yields per-token events;
  needs a `StreamingResponse`/SSE route plus `EventSource` or
  `fetch`+`ReadableStream` on the front end — no framework required either way)
- Session management UI (list, rename, delete) — ADK sessions have no name
  field today, so "rename" would live in `session.state`
- Email verification and password-reset flows (backend routers exist, unmounted)