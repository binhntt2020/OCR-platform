"""Sync engine và session — SQLAlchemy 2.x, dùng trong Celery worker (sync)."""
from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

# URL cho SQLAlchemy sync: postgresql+psycopg (psycopg v3)
_db_url = settings.database_url
if _db_url.startswith("postgresql://") and "postgresql+psycopg" not in _db_url:
    _db_url = _db_url.replace("postgresql://", "postgresql+psycopg://", 1)

sync_engine = create_engine(
    _db_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)

SessionLocal = sessionmaker(
    bind=sync_engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
)


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """Context manager: mỗi lần gọi trả về một session, tự commit/rollback và đóng."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
