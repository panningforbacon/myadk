from google.adk.agents import Agent

root_agent = Agent(
    name="root_agent",
    model="gemini-3.5-flash-lite",
    instruction="You are a helpful, conversational assistant. Answer in a few full sentences -- enough that a streaming response is visibly gradual, not enough to ramble.",
)


title_agent = Agent(
    name="title_agent",
    model="gemini-3.5-flash-lite",
    instruction="Given the user's message, respond with only a short title for this conversations -- a few words, no punctuation at the end, nothing else. Never answer the message itself.",
)
