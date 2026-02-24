"""Declarative base SQLAlchemy 2.x — thống nhất với API (app.db.base)."""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base cho tất cả model; đồng bộ với apps/api/app/db/base.py."""
    pass
