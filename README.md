# My first Google-ADK + FastAPI app
This is just the scaffold to connect `Agent` + `SessionService` -> `Runner`, and then `runner.run_async()` inside a FastAPI endpoint.

## Usage:

1. Start server:
```shell
uv run hypercorn app.main:app --bind 0.0.0.0:8000
```

2. Send a test request:
```shell
curl -X POST localhost:8000/chat -H 'content-type: application/json' -d '{"message":"what is a session?"}'
```

or in PowerShell:
```PowerShell
curl.exe -X POST http://127.0.0.1:8000/chat -H "Content-Type: application/json" -d '{\"message\": \"what is a session?\"}'
curl.exe -X POST http://127.0.0.1:8000/chat -H "Content-Type: application/json" -d '{\"user_id\": \"steve84\", \"message\": \"What is a session?\"}' 
```