"""`python -m folio_ai` — run the backend (127.0.0.1:8765 by default)."""

import logging
import sys

import uvicorn

from .config import get_settings


def database_reachable(url: str) -> str | None:
    """None when PostgreSQL answers; otherwise a short, actionable message."""
    import psycopg

    try:
        with psycopg.connect(url.replace("postgresql+psycopg", "postgresql"), connect_timeout=5):
            return None
    except psycopg.OperationalError as e:
        first = str(e).strip().splitlines()[0] if str(e).strip() else e.__class__.__name__
        return f"PostgreSQL isn't reachable ({first}).\nStart it with `npm run ai:db` (Docker must be running), then run `npm run ai` again."


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = get_settings()
    problem = database_reachable(s.db_url)
    if problem:
        print(problem, file=sys.stderr)
        sys.exit(1)
    uvicorn.run("folio_ai.app:create_app", factory=True, host=s.host, port=s.port, log_level="info")


if __name__ == "__main__":
    main()
