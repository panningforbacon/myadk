from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel

load_dotenv()

from app.agent import root_agent

APP_NAME = "adk_fastapi_demo"

session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)

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
    session = await session_service.create_session(app_name=APP_NAME, user_id=user_id)
    return SessionResponse(session_id=session.id)


@app.get("/users/{user_id}/sessions", response_model=ListSessionsResponse)
async def list_sessions(user_id: str) -> ListSessionsResponse:
    result = await session_service.list_sessions(app_name=APP_NAME, user_id=user_id)
    return ListSessionsResponse(sessions=[SessionSummary(session_id=s.id, last_update_time=s.last_update_time) for s in result.sessions])


@app.delete("/users/{user_id}/sessions/{session_id}", status_code=204)
async def delete_session(user_id: str, session_id: str) -> None:
    session = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    await session_service.delete_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    session = await session_service.get_session(
        app_name=APP_NAME,
        user_id=req.user_id,
        session_id=req.session_id,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    user_message = types.Content(role="user", parts=[types.Part(text=req.message)])

    final_text = ""
    async for event in runner.run_async(  # Use runner.run_stream() for streaming responses
        user_id=req.user_id,
        session_id=req.session_id,
        new_message=user_message,
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = event.content.parts[0].text or ""

    return ChatResponse(response=final_text)
