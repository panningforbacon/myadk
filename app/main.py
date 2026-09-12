import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.types import Receive, Scope, Send

from app import core
from app.db import User, create_db_and_tables
from app.observability import configure_logging, configure_tracing
from app.schemas import UserCreate, UserRead
from app.security import SameOriginOnly
from app.users import auth_backend, current_active_user, fastapi_users

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    await create_db_and_tables()
    await core.session_service.prepare_tables()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(SameOriginOnly)

# configure_tracing(app)

api = APIRouter(prefix="/api")

api.include_router(fastapi_users.get_auth_router(auth_backend), prefix="/auth", tags=["auth"])
api.include_router(fastapi_users.get_register_router(UserRead, UserCreate), prefix="/auth", tags=["auth"])


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
    title: str | None


class ListSessionsResponse(BaseModel):
    sessions: list[SessionSummary]


class RenameSessionRequest(BaseModel):
    title: str


class TitleRequest(BaseModel):
    message: str


class TitleResponse(BaseModel):
    title: str


class PartOut(BaseModel):
    kind: Literal["text", "thought"]
    text: str


class TurnOut(BaseModel):
    role: str
    parts: list[PartOut]


class TranscriptResponse(BaseModel):
    turns: list[TurnOut]


NDJSON_MEDIA_TYPE = "application/x-ndjson"


def _line(payload: dict) -> str:
    # json escapes any newline inside the payload, so splitting the stream on
    # "\n" downstream is unambiguous.
    return json.dumps(payload, ensure_ascii=False) + "\n"


async def _ndjson(events: AsyncIterator[core.StreamEvent]) -> AsyncIterator[str]:
    """Serialize typed events, always terminating with exactly one done-or-error.

    A stream ending with neither is how the client learns it was cut off -- the
    one thing text/plain could never distinguish from success. Failures after
    this point can't be status codes; the 200 went out with the first chunk.
    """
    try:
        async for event in events:
            match event:
                case core.TurnPart(kind=kind, text=text):
                    yield _line({"type": kind, "delta": text})
                case _:
                    # StreamEvent is a union built to widen. Dropping a new
                    # member silently would be near-undebuggable client-side.
                    logger.error(f"unserializable stream event: {event!r}")
        yield _line({"type": "done"})
    except core.ConcurrentUpdateError:
        logger.warning("lost a write race mid-turn")
        yield _line({"type": "error", "code": "stale_session"})
    except Exception:
        # CancelledError is a BaseException, so a client disconnect propagates
        # past this rather than being reported to nobody as a server fault.
        logger.exception("stream failed")
        yield _line({"type": "error", "code": "internal"})


@api.get("/health", response_model=HealthResponse)
async def get_health():
    return HealthResponse(status="pass")


@api.post("/sessions", response_model=SessionResponse)
async def create_session(user: User = Depends(current_active_user)) -> SessionResponse:
    session_id = await core.create_session(str(user.id))
    return SessionResponse(session_id=session_id)


@api.get("/sessions", response_model=ListSessionsResponse)
async def list_sessions(user: User = Depends(current_active_user)) -> ListSessionsResponse:
    sessions = await core.list_sessions(str(user.id))
    return ListSessionsResponse(sessions=[SessionSummary(session_id=s.session_id, last_update_time=s.last_update_time, title=s.title) for s in sessions])


@api.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, user: User = Depends(current_active_user)) -> None:
    try:
        await core.delete_session(str(user.id), session_id)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session not found") from err


@api.patch("/sessions/{session_id}", status_code=204)
async def rename_session(session_id: str, req: RenameSessionRequest, user: User = Depends(current_active_user)) -> None:
    try:
        await core.rename_session(str(user.id), session_id, req.title)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session not found") from err
    except core.ConcurrentUpdateError as err:
        raise HTTPException(status_code=409, detail="session was being written concurrently") from err


@api.get("/sessions/{session_id}/messages", response_model=TranscriptResponse)
async def get_transcript(session_id: str, user: User = Depends(current_active_user)) -> TranscriptResponse:
    try:
        turns = await core.get_transcript(str(user.id), session_id)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session not found") from err
    return TranscriptResponse(turns=[TurnOut(role=t.role, text=t.text) for t in turns])


@api.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, user: User = Depends(current_active_user)) -> ChatResponse:
    try:
        response = await core.send_message(str(user.id), req.session_id, req.message)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session_not_found") from err
    return ChatResponse(response=response)


@api.post("/chat/stream")
async def chat_stream(req: ChatRequest, user: User = Depends(current_active_user)):
    # The last point where a missing session can still be a status code: once
    # StreamingResponse sends headers, 200 is already committed.
    if not await core.session_exists(str(user.id), req.session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return StreamingResponse(
        _ndjson(core.stream_message(str(user.id), req.session_id, req.message)),
        media_type=NDJSON_MEDIA_TYPE,
    )


@api.post("/sessions/{session_id}/title", response_model=TitleResponse)
async def generate_session_title(session_id: str, req: TitleRequest, user: User = Depends(current_active_user)) -> TitleResponse:
    try:
        title = await core.maybe_generate_title(str(user.id), session_id, req.message)
    except core.SessionNotFoundError as err:
        raise HTTPException(status_code=404, detail="session not found") from err
    except core.ConcurrentUpdateError as err:
        raise HTTPException(status_code=409, detail="session was being written concurrently") from err
    return TitleResponse(title=title)


# include_router copies routes at call time, so this must come after every
# decorator above -- anything registered on `api` later would silently not exist.
app.include_router(api)


async def _api_not_found(scope: Scope, receive: Receive, send: Send) -> None:
    await JSONResponse({"detail": "not found"}, status_code=404)(scope, receive, send)


# An unmatched /api path would otherwise fall through to the static mount and
# answer an API call with HTML. A Mount rather than a catch-all route, so it
# stays out of the OpenAPI schema the frontend will generate its types from.
app.mount("/api", _api_not_found, name="api-404")

# Mounted last: Starlette matches routes in registration order, so every
# explicit API route above wins over this catch-all. html=True serves
# index.html for "/" and any unmatched path under it.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
