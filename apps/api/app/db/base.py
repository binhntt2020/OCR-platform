"""Declarative base cho SQLAlchemy 2.x — dùng chung cho mọi model."""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base cho tất cả model; sau này có thể thêm mixin (created_at chung, v.v.)."""
    pass
