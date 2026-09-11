import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.errors import StaleSessionError
from google.adk.events import Event, EventActions
from google.adk.runners import Runner
from google.adk.sessions import DatabaseSessionService
from google.genai import types

from app.agent import root_agent, title_agent
from app.db import engine

logger = logging.getLogger(__name__)

APP_NAME = "adk_fastapi_demo"
TITLE_APP_NAME = "adk_fastapi_demo_titles"

session_service = DatabaseSessionService(db_engine=engine)
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)
title_runner = Runner(app_name=TITLE_APP_NAME, agent=title_agent, session_service=session_service)


class SessionNotFoundError(Exception):
    """Raised for any operation against a user_id/session_id pair that doesn't exist."""


class ConcurrentUpdateError(Exception):
    """A session write lost ADK's optimistic-concurrency check and couldn't be retried."""


PartKind = Literal["text", "thought"]


@dataclass(frozen=True)
class TurnPart:
    """One text-bearing piece of a model turn, tagged with what kind it is."""

    kind: PartKind
    text: str


# A streamed delta and a stored transcript part carry the same payload, so they
# share one type. Aliased rather than used directly so tool calls and grounding
# can widen this union later without touching stream_message's signature.
type StreamEvent = TurnPart


@dataclass
class SessionInfo:
    session_id: str
    last_update_time: float
    title: str | None


@dataclass
class Turn:
    role: str  # "user" | "assistant"
    parts: list[TurnPart]


DEFAULT_TITLE = "Untitled"

RENAME_ATTEMPTS = 3


async def create_session(user_id: str) -> str:
    session = await session_service.create_session(app_name=APP_NAME, user_id=user_id)
    return session.id


async def list_sessions(user_id: str) -> list[SessionInfo]:
    result = await session_service.list_sessions(app_name=APP_NAME, user_id=user_id)
    return [SessionInfo(session_id=s.id, last_update_time=s.last_update_time, title=s.state.get("title")) for s in result.sessions]


async def delete_session(user_id: str, session_id: str) -> None:  # raises SessionNotFoundError
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")
    await session_service.delete_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)


def _parts(content: types.Content | None) -> list[TurnPart]:
    """Every text-bearing part, in order, tagged thought-or-answer."""
    if not content or not content.parts:
        return []
    return [TurnPart(kind="thought" if part.thought else "text", text=part.text) for part in content.parts if part.text]


def _answer_text(content: types.Content | None) -> str:
    """The answer alone, thoughts excluded, concatenated across parts."""
    return "".join(part.text for part in _parts(content) if part.kind == "text")


async def get_transcript(user_id: str, session_id: str) -> list[Turn]:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    turns = []
    for event in session.events:
        if not (event.author == "user" or event.is_final_response()):
            continue
        parts = _parts(event.content)
        if not parts:
            continue
        role = "user" if event.author == "user" else "assistant"
        turns.append(Turn(role=role, parts=parts))

    return turns


async def session_exists(user_id: str, session_id: str) -> bool:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return session is not None


async def maybe_generate_title(user_id: str, session_id: str, first_message: str) -> str:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    current_title = session.state.get("title")
    if current_title:
        return current_title

    title = await generate_title(first_message)
    if not title:
        title = DEFAULT_TITLE

    await rename_session(user_id, session_id, title)
    return title


async def rename_session(user_id: str, session_id: str, title: str) -> None:
    """Write the title, reloading and retrying if a concurrent writer beat us."""

    for attempt in range(1, RENAME_ATTEMPTS + 1):
        session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
        if session is None:
            raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

        event = Event(author="system", actions=EventActions(state_delta={"title": title}))
        try:
            await session_service.append_event(session, event)
            return
        except StaleSessionError:
            logger.warning(f"stale session on rename of {session_id!r}, attempt {attempt}/{RENAME_ATTEMPTS}")

    raise ConcurrentUpdateError(f"gave up renaming {session_id!r} after {RENAME_ATTEMPTS} attempts")


async def generate_title(first_message: str) -> str:
    title_user_id = "title_generator"
    session = await session_service.create_session(app_name=TITLE_APP_NAME, user_id=title_user_id)
    try:
        user_message = types.Content(role="user", parts=[types.Part(text=first_message)])
        title = ""
        async for event in title_runner.run_async(user_id=title_user_id, session_id=session.id, new_message=user_message):
            if event.is_final_response():
                title = _answer_text(event.content)
        return title.strip()
    finally:
        await session_service.delete_session(app_name=TITLE_APP_NAME, user_id=title_user_id, session_id=session.id)


async def stream_message(user_id: str, session_id: str, message: str) -> AsyncIterator[StreamEvent]:
    """Yield each delta once, whether or not the model streamed it."""

    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    user_message = types.Content(role="user", parts=[types.Part(text=message)])
    run_config = RunConfig(streaming_mode=StreamingMode.SSE)

    awaiting_aggregate = False
    try:
        async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=user_message, run_config=run_config):
            if event.partial:
                for part in _parts(event.content):
                    awaiting_aggregate = True
                    yield part
            else:
                if not awaiting_aggregate:
                    # No partials preceded this one, so the aggregate is the only
                    # delivery of this content rather than a repeat of it.
                    for part in _parts(event.content):
                        yield part
                # Reset per LLM call, not per invocation: a tool call splits one
                # turn into several, each with its own partials-then-aggregate.
                awaiting_aggregate = False
    except StaleSessionError as err:
        raise ConcurrentUpdateError(f"lost a write race mid-stream on session {session_id!r}") from err


async def send_message(user_id: str, session_id: str, message: str) -> str:  # raises SessionNotFoundError
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    user_message = types.Content(role="user", parts=[types.Part(text=message)])

    final_text = ""
    try:
        async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=user_message):
            if event.is_final_response():
                final_text = _answer_text(event.content)
    except StaleSessionError as err:
        raise ConcurrentUpdateError(f"lost a write race on session {session_id!r}") from err

    return final_text
