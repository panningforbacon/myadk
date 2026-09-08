# Summary of development steps
1. Build the initial *Google ADK* agent behind a FastAPI endpoint
2. Add multi-user session isolation
3. Use `python-dotenv` to store configs -- e.g., GOOGLE_API_KEY
4. Add multi-session-per-user
5. Add CLI access to call the agent
6. Add basic user management (via `fastapi-users`) and SQLite
7. Add a front-end to the web app
8. Add streaming responses
9. Reverted 'send_message()', no longer a thin wrapper of 'stream_message()'
10. Replace InMemorySessionService with DatabaseSessionService


# Backlog
- Multi-session management (list/rename/delete)
- Email verification of registrations
- Password reset functionality
- Superuser: Optionally view all users and access their sessions (as read-only)
- Observability