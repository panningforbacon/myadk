import asyncio

from app import core

CLI_USER_ID = "local-user"


async def _run() -> None:
    session_id = await core.create_session(CLI_USER_ID)
    print(f"session {session_id} -- type 'exit' to quite")

    while True:
        message = input("> ")
        if message.strip().lower() in ("exit", "quit"):
            break

        try:
            print(await core.send_message(CLI_USER_ID, session_id, message))
        except core.SessionNotFoundError:
            print("session vanished -- restart the CLI")
            break


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
