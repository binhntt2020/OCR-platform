"""Load system_config.yml và get_config(system_config, keys). Path từ env OCR_SYSTEM_CONFIG, base từ OCR_CONFIG_BASE."""
from __future__ import annotations
import os
from pathlib import Path
from typing import Any


def _load_yaml(path: str) -> dict:
    import yaml
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def get_config(system_config: dict, keys: list[str]) -> Any:
    """Lấy giá trị lồng nhau: get_config(cfg, ["craft_net", "weights"]) -> cfg["craft_net"]["weights"]."""
    v = system_config
    for k in keys:
        v = v.get(k) if isinstance(v, dict) else None
        if v is None:
            return None
    return v


def resolve_path(path: str | None, base: str | Path) -> str | None:
    """Nếu path tương đối thì join với base; trả về None nếu path None."""
    if not path:
        return None
    path = path.strip()
    if not path:
        return None
    p = Path(path)
    if not p.is_absolute():
        p = Path(base) / p
    return str(p.resolve())


def load_system_config() -> tuple[dict, Path]:
    """
    Load infra/system_config.yml.
    - Path file: env OCR_SYSTEM_CONFIG, hoặc OCR_CONFIG_BASE/infra/system_config.yml, hoặc None (trả về {}, Path('.')).
    - Base để resolve path tương đối: env OCR_CONFIG_BASE hoặc thư mục chứa file config.
    Returns (config_dict, base_path).
    """
    config_path = os.getenv("OCR_SYSTEM_CONFIG", "").strip()
    base_env = os.getenv("OCR_CONFIG_BASE", "").strip()
    if not config_path and base_env:
        config_path = str(Path(base_env) / "infra" / "system_config.yml")
    if not config_path:
        return {}, Path(".")
    path = Path(config_path).resolve()
    if not path.is_file():
        return {}, path.parent
    cfg = _load_yaml(str(path))
    if base_env:
        base = Path(base_env).resolve()
    else:
        # Nếu config nằm trong .../infra/system_config.yml thì base = repo root
        base = path.parent
        if path.parent.name == "infra":
            base = path.parent.parent
    return cfg, base
