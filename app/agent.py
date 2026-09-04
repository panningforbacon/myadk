from google.adk.agents import Agent

root_agent = Agent(
    name="root_agent",
    model="gemini-3.5-flash-lite",
    instruction="You are a minimalist assistant. Keep your answers under 10 words.",
)
