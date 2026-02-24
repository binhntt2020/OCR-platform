"""DB layer worker — SQLAlchemy 2.x sync (Session). Giống API nhưng dùng sync thay vì async."""
from app.db.base import Base
from app.db.models import OcrJob
from app.db.session import SessionLocal, get_session, sync_engine

__all__ = ["Base", "OcrJob", "SessionLocal", "get_session", "sync_engine"]
