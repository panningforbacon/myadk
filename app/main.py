from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import core
from app.db import User, create_db_and_tables
from app.schemas import UserCreate, UserRead
from app.users import auth_backend, current_active_user, fastapi_users


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_db_and_tables()
    yield


app = FastAPI(lifespan=lifespan)

app.include_router(fastapi_users.get_auth_router(auth_backend), prefix="/auth", tags=["auth"])
app.include_router(fastapi_users.get_register_router(UserRead, UserCreate), prefix="/auth", tags=["auth"])


class HealthResponse(BaseModel):
    status: str


class ChatRequest(BaseModel):
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


class TurnOut(BaseModel):
    role: str
    text: str


class TranscriptResponse(BaseModel):
    turns: list[TurnOut]


@app.get("/health", response_model=HealthResponse)
async def get_health():
    return HealthResponse(status="pass")


@app.post("/sessions", response_model=SessionResponse)
async def create_session(user: User = Depends(current_active_user)) -> SessionResponse:
    session_id = await core.create_session(str(user.id))
    return SessionResponse(session_id=session_id)


@app.get("/sessions", response_model=ListSessionsResponse)
async def list_sessions(user: User = Depends(current_active_user)) -> ListSessionsResponse:
    sessions = await core.list_sessions(str(user.id))
    return ListSessionsResponse(sessions=[SessionSummary(session_id=s.session_id, last_update_time=s.last_update_time) for s in sessions])


@app.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, user: User = Depends(current_active_user)) -> None:
    try:
        await core.delete_session(str(user.id), session_id)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session not found") from err


@app.get("/sessions/{session_id}/message", response_model=TranscriptResponse)
async def get_transcript(session_id: str, user: User = Depends(current_active_user)) -> TranscriptResponse:
    try:
        turns = await core.get_transcript(str(user.id), session_id)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session not found") from err
    return TranscriptResponse(turns=[TurnOut(role=t.role, text=t.text) for t in turns])


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, user: User = Depends(current_active_user)) -> ChatResponse:
    try:
        response = await core.send_message(str(user.id), req.session_id, req.message)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session_not_found") from err
    return ChatResponse(response=response)


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest, user: User = Depends(current_active_user)):
    if not await core.session_exists(str(user.id), req.session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return StreamingResponse(
        core.stream_message(str(user.id), req.session_id, req.message),
        media_type="text/plain",
    )


# Mounted last: Starlette matches routes in registration order, so every
# explicit API route above wins over this catch-all. html=True serves
# index.html for "/" and any unmatched path under it.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
