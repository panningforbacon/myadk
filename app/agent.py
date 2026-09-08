from google.adk.agents import Agent

root_agent = Agent(
    name="root_agent",
    model="gemini-3.5-flash-lite",
    instruction="You are a helpful, conversational assistant. Answer in a few full sentences -- enough that a streaming response is visibly gradual, not enough to ramble.",
)
