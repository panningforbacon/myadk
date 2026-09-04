# My first Google-ADK + FastAPI app
This is just the scaffold to connect `Agent` + `SessionService` -> `Runner`, and then `runner.run_async()` inside a FastAPI endpoint.

## Usage:

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