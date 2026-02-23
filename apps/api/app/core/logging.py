"""Logging configuration: format, level, console + file theo ngày (tự tạo file nếu chưa có)."""
import logging
import sys
from datetime import date
from pathlib import Path

from app.core.config import settings


_logging_configured = False


def _log_path_for_today() -> Path:
    """Đường dẫn file log theo ngày hiện tại."""
    base = Path(settings.log_file)
    day_suffix = date.today().strftime("%Y-%m-%d")
    if base.suffix:
        return base.parent / f"{base.stem}-{day_suffix}{base.suffix}"
    return base / f"api-{day_suffix}.log"


class DailyFileHandler(logging.FileHandler):
    """Handler ghi log theo ngày: mỗi lần emit kiểm tra file theo ngày, chưa có thì tạo và mở."""

    def __init__(self, base_path: str, encoding: str | None = "utf-8"):
        self._base_path = Path(base_path)
        path = _log_path_for_today()
        day = path.stem.split("-")[-1] if "-" in path.stem else date.today().strftime("%Y-%m-%d")
        self._current_day = day
        self._encoding = encoding or "utf-8"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        super().__init__(str(path), encoding=encoding, mode="a")

    def _path_today(self) -> Path:
        path = _log_path_for_today()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        return path

    def emit(self, record: logging.LogRecord) -> None:
        path = self._path_today()
        day = path.stem.split("-")[-1] if "-" in path.stem else date.today().strftime("%Y-%m-%d")
        if self._current_day != day or getattr(self.stream, "closed", True):
            try:
                if self.stream and not getattr(self.stream, "closed", True):
                    self.stream.close()
            except Exception:
                pass
            self._current_day = day
            self.baseFilename = str(path)
            self.stream = open(self.baseFilename, "a", encoding=self._encoding)
        super().emit(record)
        if self.stream:
            self.stream.flush()


def setup_logging() -> None:
    """Cấu hình logging cho app: format, level, handler (console + file theo ngày)."""
    global _logging_configured
    if _logging_configured:
        return
    _logging_configured = True

    level = getattr(logging, settings.log_level, logging.INFO)
    format_str = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
    date_fmt = "%Y-%m-%d %H:%M:%S"
    formatter = logging.Formatter(format_str, datefmt=date_fmt)

    root = logging.getLogger()
    root.setLevel(level)
    _log_file_used = None

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(level)
    console.setFormatter(formatter)
    root.addHandler(console)

    if settings.log_file:
        try:
            path = _log_path_for_today()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch(exist_ok=True)
            fh = DailyFileHandler(settings.log_file, encoding="utf-8")
            fh.setLevel(level)
            fh.setFormatter(formatter)
            root.addHandler(fh)
            # Ghi access log của uvicorn vào file (uvicorn có thể không propagate lên root)
            for uvicorn_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
                uvicorn_logger = logging.getLogger(uvicorn_name)
                uvicorn_logger.addHandler(fh)
            _log_file_used = str(path)
        except OSError as e:
            root.warning("Không mở được log file %s: %s", settings.log_file, e)

    logger = logging.getLogger("app")
    logger.setLevel(level)
    logger.info("Đã cấu hình log: mức=%s, file=%s", settings.log_level, _log_file_used or "chỉ console")


def get_logger(name: str = "app") -> logging.Logger:
    """Lấy logger để ghi log trong module."""
    return logging.getLogger(name)
