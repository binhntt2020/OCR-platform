"""Async engine và session — SQLAlchemy 2.x, dùng với FastAPI dependency."""
from collections.abc import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from app.core.config import settings
from app.db.base import Base

# Async engine: đổi driver theo CSDL (postgresql+asyncpg, mysql+aiomysql, sqlite+aiosqlite)
async_engine = create_async_engine(
    settings.database_url_async,
    echo=False,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)

async_session_factory = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Dependency FastAPI: mỗi request một session, tự commit/rollback và đóng."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
