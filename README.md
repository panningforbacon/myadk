# My first Google-ADK + FastAPI app
This is just the scaffold to connect `Agent` + `SessionService` -> `Runner`, and then `runner.run_async()` inside a FastAPI endpoint or a CLI REPL.

`app/core.py` owns all of that wiring (agent, session service, runner) behind a plain async function contract (`create_session`, `list_sessions`, `delete_session`, `send_message`, raising `SessionNotFoundError` on a bad id). `app/main.py` and `app/cli.py` are both thin adapters over it — one translates to HTTP status codes, the other to REPL prompts. Neither talks to ADK directly.

## Usage: HTTP server

1. Start server:
```shell
uv run hypercorn app.main:app --bind 0.0.0.0:8000
```

2. Send a test request:
```shell
# 0. Get health
curl -X GET http://0.0.0.0:8000/health

# 1. Create session. 
curl -X POST http://0.0.0.0:8000/users/user123/sessions

# 2. Chat.
curl -X POST 0.0.0.0:8000/chat -H 'content-type: application/json' -d '{"user_id": "user123", "session_id": "[SESSION_ID]", "message":"How did the days of the week get their names?"}'

# 3. List sessions.
curl -X GET http://0.0.0.0:8000/users/user123/sessions

# 4. Delete session.
curl -X DELETE http://0.0.0.0:8000/users/user123/sessions/[SESSION_ID]
```

or in PowerShell:
```PowerShell
# 0. Get health.
curl.exe -X GET http://127.0.0.1:8000/health

# 1. Create session. 
curl.exe -X POST http://127.0.0.1:8000/users/user123/sessions

# 2. Chat.
curl.exe -X POST http://127.0.0.1:8000/chat -H "Content-Type: application/json" -d '{\"user_id\": \"user123\", \"session_id\": \"[SESSION_ID]\", \"message\": \"How did the days of the week get their names?\"}' 


# 3. List sessions.
curl.exe -X GET http://127.0.0.1:8000/users/user123/sessions

# 4. Delete session.
curl.exe -X DELETE http://127.0.0.1:8000/users/user123/sessions/[SESSION_ID]

```

## Usage: CLI

For local, single-user, single-session use — no HTTP involved:

```shell
uv run adk-chat
```

This creates one session for a fixed local user and drops you into a REPL:

```
session 3f9e2b7a-... -- type 'exit' to quit
> How did the days of the week get their names?
They're named after Sun, Moon, and five classical planets/gods.
> exit
```

Type `exit` or `quit` to leave.

**Important:** the CLI and the HTTP server are separate processes, and `InMemorySessionService` lives in process memory. Each one builds its own session store at startup — a conversation started in the CLI is invisible to the server and vice versa, even with the same `user_id`. Don't expect to `uv run adk-chat`, then hit `/chat` over HTTP and pick up where you left off; that would require both processes sharing a session backend, which in-memory storage doesn't do.