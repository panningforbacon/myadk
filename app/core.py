import logging
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

from google.adk.agents._streaming_mode import StreamingMode
from google.adk.agents.run_config import RunConfig
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


@dataclass
class SessionInfo:
    session_id: str
    last_update_time: float
    title: str | None


@dataclass
class Turn:
    role: str  # "user" | "assistant"
    text: str


DEFAULT_TITLE = "Untitled"


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


def _answer_text(content: types.Content | None) -> str | None:
    if not content or not content.parts:
        return None
    for part in content.parts:
        if part.thought:
            continue
        if part.text:
            return part.text
    return None


async def get_transcript(user_id: str, session_id: str) -> list[Turn]:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    turns = []
    for event in session.events:
        if not (event.author == "user" or event.is_final_response()):
            continue
        text = _answer_text(event.content)
        if not text:
            continue
        role = "user" if event.author == "user" else "assistant"
        turns.append(Turn(role=role, text=text))

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
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")
    event = Event(author="system", actions=EventActions(state_delta={"title": title}))
    try:
        await session_service.append_event(session, event)
    except StaleSessionError:
        logger.error(f"[StaleSessionError] mid-stream for session {session_id!r}; unable to set state (title='{title!r}')")


async def generate_title(first_message: str) -> str:
    title_user_id = "title_generator"
    session = await session_service.create_session(app_name=TITLE_APP_NAME, user_id=title_user_id)
    try:
        user_message = types.Content(role="user", parts=[types.Part(text=first_message)])
        title = ""
        async for event in title_runner.run_async(user_id=title_user_id, session_id=session.id, new_message=user_message):
            if event.is_final_response() and event.content and event.content.parts:
                title = event.content.parts[0].text or ""
        return title.strip()
    finally:
        await session_service.delete_session(app_name=TITLE_APP_NAME, user_id=title_user_id, session_id=session.id)


async def stream_message(user_id: str, session_id: str, message: str):
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    user_message = types.Content(role="user", parts=[types.Part(text=message)])
    run_config = RunConfig(streaming_mode=StreamingMode.SSE)

    yielded_any = False
    final_event = None
    async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=user_message, run_config=run_config):
        if event.partial:
            text = _answer_text(event.content)
            if text:
                yielded_any = True
                yield text
            elif event.is_final_response():
                final_event = event

        if not yielded_any and final_event and final_event.content and final_event.content.parts:
            text = final_event.content.parts[0].text
            if text:
                yield text


# async def send_message(user_id: str, session_id: str, message: str) -> str:
#     return "".join([chunk async for chunk in stream_message(user_id, session_id, message)])


async def send_message(user_id: str, session_id: str, message: str) -> str:  # raises SessionNotFoundError
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    user_message = types.Content(role="user", parts=[types.Part(text=message)])

    final_text = ""
    async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=user_message):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = event.content.parts[0].text or ""

    return final_text
