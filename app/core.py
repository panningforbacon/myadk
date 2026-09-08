from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.agent import root_agent

APP_NAME = "adk_fastapi_demo"

session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)


class SessionNotFoundError(Exception):
    """Raised for any operation against a user_id/session_id pair that doesn't exist."""


@dataclass
class SessionInfo:
    session_id: str
    last_update_time: float


@dataclass
class Turn:
    role: str  # "user" | "assistant"
    text: str


async def create_session(user_id: str) -> str:
    session = await session_service.create_session(app_name=APP_NAME, user_id=user_id)
    return session.id


async def list_sessions(user_id: str) -> list[SessionInfo]:
    result = await session_service.list_sessions(app_name=APP_NAME, user_id=user_id)
    return [SessionInfo(session_id=s.id, last_update_time=s.last_update_time) for s in result.sessions]


async def delete_session(user_id: str, session_id: str) -> None:  # raises SessionNotFoundError
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")
    await session_service.delete_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)


async def get_transcript(user_id: str, session_id: str) -> list[Turn]:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    turns = []
    for event in session.events:
        if not (event.author == "user" or event.is_final_response()):
            continue
        if not (event.content and event.content.parts):
            continue
        text = event.content.parts[0].text
        if not text:
            continue
        role = "user" if event.author == "user" else "assistant"
        turns.append(Turn(role=role, text=text))

    return turns


async def session_exists(user_id: str, session_id: str) -> bool:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return session is not None


async def stream_message(user_id: str, session_id: str, message: str):
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise SessionNotFoundError(f"no session {session_id!r} for user {user_id!r}")

    user_message = types.Content(role="user", parts=[types.Part(text=message)])
    run_config = RunConfig(streaming_mode=StreamingMode.SSE)

    yielded_any = False
    final_event = None
    async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=user_message, run_config=run_config):
        if event.partial and event.content and event.content.parts:
            text = event.content.parts[0].text
            if text:
                yielded_any = True
                yield text
            elif event.is_final_response():
                final_event = event

        if not yielded_any and final_event and final_event.content and final_event.content.parts:
            text = final_event.content.parts[0].text
            if text:
                yield text


async def send_message(user_id: str, session_id: str, message: str) -> str:
    return "".join([chunk async for chunk in stream_message(user_id, session_id, message)])
