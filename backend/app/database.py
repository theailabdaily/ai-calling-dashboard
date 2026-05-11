"""Async SQLAlchemy engine + session factory."""
import uuid
from collections.abc import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.config import get_settings

settings = get_settings()

# Supabase transaction pooler (port 6543, Supavisor) multiplexes many logical
# client connections onto a smaller pool of backend Postgres connections.
# asyncpg uses prepared statements (PREPARE/EXECUTE) and auto-names them
# `__asyncpg_stmt_0__`, `_1__`, etc., starting from 0 on each new connection.
# When the pooler hands us a backend conn that another client just released,
# that conn may still have `__asyncpg_stmt_5__` defined. Our PREPARE then
# fails: `prepared statement "__asyncpg_stmt_5__" already exists`.
#
# Three things together fix this for Supabase + serverless:
#   1. NullPool                       -- let the upstream pooler do the pooling
#   2. statement_cache_size=0         -- disable asyncpg's prepared statement
#                                        reuse cache (still uses PREPARE/DEALLOC
#                                        but doesn't reuse statements)
#   3. prepared_statement_name_func   -- give each prepared statement a
#                                        UUID-based unique name so collisions
#                                        across pooler reuses are impossible
engine = create_async_engine(
    settings.database_url,
    poolclass=NullPool,
    connect_args={
        "statement_cache_size": 0,
        "prepared_statement_name_func": lambda: f"__asyncpg_{uuid.uuid4().hex}__",
    },
    echo=False,
)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency."""
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
