"""
Shared Logging Configuration
Used by both api/ and split_code/ modules to replace debug print statements
"""
import logging
import os
from pathlib import Path
from logging.handlers import RotatingFileHandler

LOG_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}

_CONFIGURED = False

def configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    level_name = os.getenv("LOG_LEVEL", "info").lower()
    level = LOG_LEVELS.get(level_name, logging.INFO)

    project_root = Path(__file__).resolve().parent
    # LOG_DIR lets a host keep logs outside the deployed code (e.g. /home/data/logs on Azure App Service).
    log_dir = Path(os.getenv("LOG_DIR", "").strip() or project_root / "logs")
    log_dir.mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    if root_logger.handlers:
        root_logger.handlers.clear()

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)

    app_file_handler = RotatingFileHandler(
        log_dir / "salescoach.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    app_file_handler.setLevel(level)
    app_file_handler.setFormatter(formatter)

    error_file_handler = RotatingFileHandler(
        log_dir / "errors.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    error_file_handler.setLevel(logging.ERROR)
    error_file_handler.setFormatter(formatter)

    root_logger.addHandler(console_handler)
    root_logger.addHandler(app_file_handler)
    root_logger.addHandler(error_file_handler)

    _CONFIGURED = True

def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(name)
