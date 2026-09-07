from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel

from app import core

app = FastAPI()


class HealthResponse(BaseModel):
    status: str


class ChatRequest(BaseModel):
    user_id: str
    session_id: str
    message: str


class ChatResponse(BaseModel):
    response: str


class SessionResponse(BaseModel):
    session_id: str


class SessionSummary(BaseModel):
    session_id: str
    last_update_time: float


class ListSessionsResponse(BaseModel):
    sessions: list[SessionSummary]


@app.get("/health", response_model=HealthResponse)
async def get_health():
    return HealthResponse(status="pass")


@app.post("/users/{user_id}/sessions", response_model=SessionResponse)
async def create_session(user_id: str) -> SessionResponse:
    session_id = await core.create_session(user_id)
    return SessionResponse(session_id=session_id)


@app.get("/users/{user_id}/sessions", response_model=ListSessionsResponse)
async def list_sessions(user_id: str) -> ListSessionsResponse:
    sessions = await core.list_sessions(user_id)
    return ListSessionsResponse(sessions=[SessionSummary(session_id=s.session_id, last_update_time=s.last_update_time) for s in sessions])


@app.delete("/users/{user_id}/sessions/{session_id}", status_code=204)
async def delete_session(user_id: str, session_id: str) -> None:
    try:
        await core.delete_session(user_id, session_id)
    except core.SessionNotFoundError:
        raise HTTPException(status_code=404, detail="session not found")


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    try:
        response = await core.send_message(req.user_id, req.session_id, req.message)
    except core.SessionNotFoundError:
        raise HTTPException(status_code=404, detail="session_not_found")
    return ChatResponse(response=response)
