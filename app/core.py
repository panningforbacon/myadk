from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.agent import root_agent

APP_NAME = "adk_fastapi_demo"


class SessionNotFoundError(Exception): ...


@dataclass
class SessionInfo:
    session_id: str
    last_update_time: float


session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)


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
