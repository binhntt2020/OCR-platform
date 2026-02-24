"""
Centralized logging configuration using loguru.
Format: time | level | name | function | message (đồng bộ kiểu với API, có thêm function).
"""
import os
import sys
from loguru import logger

# Remove default handler
logger.remove()

_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
if _LOG_LEVEL not in ("DEBUG", "INFO", "WARNING", "ERROR"):
    _LOG_LEVEL = "INFO"
_FORMAT_CONSOLE = (
    "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | "
    "<cyan>{name}</cyan> | <cyan>{function}</cyan> | <level>{message}</level>"
)
_FORMAT_FILE = (
    "{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name} | {function} | {message}"
)

# Console handler
logger.add(
    sys.stdout,
    colorize=True,
    format=_FORMAT_CONSOLE,
    level=_LOG_LEVEL,
)

# File handler (theo ngày, tên file worker)
logger.add(
    "logs/worker_{time:YYYY-MM-DD}.log",
    rotation="00:00",
    retention="30 days",
    level="INFO",
    format=_FORMAT_FILE,
)


def get_logger(name: str = "worker"):
    """Lấy logger gắn với tên module (giống API). Log sẽ có {name} và {function}."""
    return logger.bind(name=name)


# Export
__all__ = ["logger", "get_logger"]
