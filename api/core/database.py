"""
Shared Database Module for Sales Coach API.

Provides consistent database access across all routers, including schema initialization and
backward-compatible migrations. SQLite by default; PostgreSQL when DATABASE_URL is set.

Queries are written once, in SQLite style ("?" placeholders, rows readable as row[0] or row["name"]);
on PostgreSQL a thin wrapper converts the placeholders and returns rows that behave the same way.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator, Optional, Sequence

from api.core.config import DATABASE_PATH, DATABASE_URL
from shared_logger import get_logger


logger = get_logger(__name__)

IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

try:  # psycopg is only needed for PostgreSQL
    import psycopg
except ImportError:  # pragma: no cover - SQLite-only installs
    psycopg = None

# Catch this instead of sqlite3.IntegrityError so duplicate keys are handled on either database.
IntegrityError: tuple = (sqlite3.IntegrityError,) + ((psycopg.IntegrityError,) if psycopg else ())


def is_unique_violation(exc: BaseException) -> bool:
    """True when an IntegrityError is a duplicate key (SQLite or PostgreSQL)."""
    if psycopg is not None and isinstance(exc, psycopg.errors.UniqueViolation):
        return True
    return "UNIQUE constraint" in str(exc)


# ── PostgreSQL adapter ───────────────────────────────────────────

class _Row(dict):
    """A result row readable by column name (row["name"]) and by position (row[0]), like sqlite3.Row."""

    __slots__ = ("_values",)

    def __init__(self, names: Sequence[str], values: Sequence[Any]) -> None:
        super().__init__(zip(names, values))
        self._values = tuple(values)

    def __getitem__(self, key):  # type: ignore[override]
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


def _row_factory(cursor):
    names = [col.name for col in cursor.description] if cursor.description else []
    return lambda values: _Row(names, values)


def _to_postgres_sql(sql: str) -> str:
    # The queries use "?" placeholders and contain no literal "?" or "%".
    return sql.replace("%", "%%").replace("?", "%s")


class _PgCursor:
    def __init__(self, cursor) -> None:
        self._cursor = cursor

    def execute(self, sql: str, params: Optional[Sequence[Any]] = None):
        self._cursor.execute(_to_postgres_sql(sql), tuple(params) if params else None)
        return self

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()

    def __iter__(self):
        return iter(self._cursor)

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount

    @property
    def description(self):
        return self._cursor.description


class _PgConnection:
    def __init__(self, conn) -> None:
        self._conn = conn

    def cursor(self) -> _PgCursor:
        return _PgCursor(self._conn.cursor(row_factory=_row_factory))

    def execute(self, sql: str, params: Optional[Sequence[Any]] = None) -> _PgCursor:
        return self.cursor().execute(sql, params)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()


_pg_pool = None


def _postgres_pool():
    global _pg_pool
    if _pg_pool is None:
        if psycopg is None:
            raise RuntimeError("DATABASE_URL points at PostgreSQL but psycopg is not installed")
        from psycopg_pool import ConnectionPool

        _pg_pool = ConnectionPool(
            DATABASE_URL,
            min_size=1,
            max_size=int(os.getenv("DATABASE_POOL_SIZE", "10")),
            timeout=30,
            open=True,
        )
        logger.info("PostgreSQL connection pool opened")
    return _pg_pool


def get_db_path() -> str:
    """Return the absolute path to the SQLite database file."""
    return os.path.abspath(DATABASE_PATH)


def database_backend() -> str:
    return "postgresql" if IS_POSTGRES else "sqlite"


def get_db_connection() -> sqlite3.Connection:
    """
    Create a SQLite connection with concurrency-friendly settings.

    WAL mode improves concurrent read access. The busy timeout allows
    SQLite writes to wait temporarily instead of immediately failing
    with a database-locked error.
    """
    os.makedirs(os.path.dirname(get_db_path()), exist_ok=True)
    conn = sqlite3.connect(
        get_db_path(),
        timeout=30.0,
    )
    conn.row_factory = sqlite3.Row

    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")

    return conn


@contextmanager
def db_connection() -> Iterator[Any]:
    """
    Context manager for database connections (SQLite, or PostgreSQL from the pool).

    Rolls back the active transaction when an exception occurs and
    always closes (or returns) the connection.
    """
    if IS_POSTGRES:
        # The pool commits on a clean exit and rolls back on an exception.
        with _postgres_pool().connection() as raw:
            yield _PgConnection(raw)
        return

    conn = get_db_connection()

    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _get_table_columns(
    cursor: sqlite3.Cursor,
    table_name: str,
) -> set:
    """Return the existing column names for a SQLite table."""
    cursor.execute(f"PRAGMA table_info({table_name})")
    return {str(row["name"]) for row in cursor.fetchall()}


def _add_column_if_missing(
    cursor: sqlite3.Cursor,
    table_name: str,
    column_name: str,
    column_definition: str,
) -> bool:
    """
    Add a column to an existing table if the column is missing.

    Returns True when a migration was applied and False when the
    column already existed.
    """
    existing_columns = _get_table_columns(
        cursor,
        table_name,
    )

    if column_name in existing_columns:
        return False

    cursor.execute(
        f"""
        ALTER TABLE {table_name}
        ADD COLUMN {column_name} {column_definition}
        """
    )

    logger.info(
        "Database migration added column: %s.%s",
        table_name,
        column_name,
    )

    return True


def _evaluation_results_has_cascade(
    cursor: sqlite3.Cursor,
) -> bool:
    """Return whether evaluation_results uses ON DELETE CASCADE."""
    cursor.execute(
        """
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'evaluation_results'
        """
    )
    row = cursor.fetchone()

    return bool(
        row
        and "ON DELETE CASCADE" in str(row["sql"] or "").upper()
    )


def _conversation_history_has_cascade(
    cursor: sqlite3.Cursor,
) -> bool:
    """Return whether conversation_history uses ON DELETE CASCADE."""
    cursor.execute(
        """
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'conversation_history'
        """
    )
    row = cursor.fetchone()

    return bool(
        row
        and "ON DELETE CASCADE" in str(row["sql"] or "").upper()
    )


def _migrate_evaluation_results_cascade(
    cursor: sqlite3.Cursor,
) -> None:
    """
    Rebuild evaluation_results with ON DELETE CASCADE.

    All columns are copied explicitly so the migration does not depend
    on the physical column order of the old table.
    """
    if _evaluation_results_has_cascade(cursor):
        return

    logger.info(
        "Migrating evaluation_results to ON DELETE CASCADE"
    )

    cursor.execute(
        "DROP TABLE IF EXISTS evaluation_results_new"
    )

    cursor.execute(
        """
        CREATE TABLE evaluation_results_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT 'admin',
            overall_score REAL,
            report_text TEXT,
            dimension_scores TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (session_id)
                REFERENCES practice_sessions(session_id)
                ON DELETE CASCADE
        )
        """
    )

    cursor.execute(
        """
        INSERT INTO evaluation_results_new (
            id,
            session_id,
            username,
            overall_score,
            report_text,
            dimension_scores,
            timestamp
        )
        SELECT
            id,
            session_id,
            COALESCE(username, 'admin'),
            overall_score,
            report_text,
            dimension_scores,
            timestamp
        FROM evaluation_results
        """
    )

    cursor.execute("DROP TABLE evaluation_results")

    cursor.execute(
        """
        ALTER TABLE evaluation_results_new
        RENAME TO evaluation_results
        """
    )

    logger.info(
        "evaluation_results cascade migration completed"
    )


def _migrate_conversation_history_cascade(
    cursor: sqlite3.Cursor,
) -> None:
    """
    Rebuild conversation_history with ON DELETE CASCADE.

    All columns are copied explicitly so the migration does not depend
    on the physical column order of the old table.
    """
    if _conversation_history_has_cascade(cursor):
        return

    logger.info(
        "Migrating conversation_history to ON DELETE CASCADE"
    )

    cursor.execute(
        "DROP TABLE IF EXISTS conversation_history_new"
    )

    cursor.execute(
        """
        CREATE TABLE conversation_history_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT 'admin',
            message_index INTEGER NOT NULL,
            role TEXT NOT NULL
                CHECK(role IN ('user', 'ai')),
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (session_id)
                REFERENCES practice_sessions(session_id)
                ON DELETE CASCADE
        )
        """
    )

    cursor.execute(
        """
        INSERT INTO conversation_history_new (
            id,
            session_id,
            username,
            message_index,
            role,
            content,
            timestamp
        )
        SELECT
            id,
            session_id,
            COALESCE(username, 'admin'),
            message_index,
            role,
            content,
            timestamp
        FROM conversation_history
        """
    )

    cursor.execute("DROP TABLE conversation_history")

    cursor.execute(
        """
        ALTER TABLE conversation_history_new
        RENAME TO conversation_history
        """
    )

    logger.info(
        "conversation_history cascade migration completed"
    )


def init_database() -> None:
    """
    Initialize the database and apply backward-compatible migrations.

    CREATE TABLE IF NOT EXISTS does not update an existing SQLite
    table, so missing columns are added explicitly with ALTER TABLE.
    """
    if IS_POSTGRES:
        _init_postgres()
        return

    with db_connection() as conn:
        cursor = conn.cursor()

        # ── Practice Sessions ────────────────────────────────────
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS practice_sessions (
                session_id TEXT PRIMARY KEY,
                username TEXT NOT NULL DEFAULT 'admin',
                timestamp TEXT NOT NULL,
                difficulty_level TEXT NOT NULL
                    CHECK(
                        difficulty_level IN (
                            'Easy',
                            'Medium',
                            'Hard',
                            'Expert'
                        )
                    ),
                client_persona TEXT,
                industry TEXT,
                company_size TEXT,
                total_practice_time INTEGER,
                document_alignment REAL,
                average_score REAL,
                scenario_type TEXT
                    DEFAULT 'Sales & Commercial Pitches',
                business_context TEXT DEFAULT 'Consulting',
                response_language TEXT DEFAULT 'en'
            )
            """
        )

        # Existing databases may have been created before these
        # columns were introduced.
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "username",
            "TEXT NOT NULL DEFAULT 'admin'",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "client_persona",
            "TEXT",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "industry",
            "TEXT",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "company_size",
            "TEXT",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "total_practice_time",
            "INTEGER",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "document_alignment",
            "REAL",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "average_score",
            "REAL",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "scenario_type",
            "TEXT DEFAULT 'Sales & Commercial Pitches'",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "business_context",
            "TEXT DEFAULT 'Consulting'",
        )
        _add_column_if_missing(
            cursor,
            "practice_sessions",
            "response_language",
            "TEXT DEFAULT 'en'",
        )

        # Backfill nullable values in migrated databases.
        cursor.execute(
            """
            UPDATE practice_sessions
            SET username = 'admin'
            WHERE username IS NULL
               OR TRIM(username) = ''
            """
        )

        cursor.execute(
            """
            UPDATE practice_sessions
            SET scenario_type = 'Sales & Commercial Pitches'
            WHERE scenario_type IS NULL
               OR TRIM(scenario_type) = ''
            """
        )

        cursor.execute(
            """
            UPDATE practice_sessions
            SET business_context = 'Consulting'
            WHERE business_context IS NULL
               OR TRIM(business_context) = ''
            """
        )

        cursor.execute(
            """
            UPDATE practice_sessions
            SET response_language = 'en'
            WHERE response_language IS NULL
               OR TRIM(response_language) = ''
            """
        )

        # ── Evaluation Results ───────────────────────────────────
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS evaluation_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT 'admin',
                overall_score REAL,
                report_text TEXT,
                dimension_scores TEXT,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id)
                    REFERENCES practice_sessions(session_id)
                    ON DELETE CASCADE
            )
            """
        )

        _add_column_if_missing(
            cursor,
            "evaluation_results",
            "username",
            "TEXT NOT NULL DEFAULT 'admin'",
        )

        cursor.execute(
            """
            UPDATE evaluation_results
            SET username = 'admin'
            WHERE username IS NULL
               OR TRIM(username) = ''
            """
        )

        # ── Conversation History ─────────────────────────────────
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS conversation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT 'admin',
                message_index INTEGER NOT NULL,
                role TEXT NOT NULL
                    CHECK(role IN ('user', 'ai')),
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id)
                    REFERENCES practice_sessions(session_id)
                    ON DELETE CASCADE
            )
            """
        )

        _add_column_if_missing(
            cursor,
            "conversation_history",
            "username",
            "TEXT NOT NULL DEFAULT 'admin'",
        )

        cursor.execute(
            """
            UPDATE conversation_history
            SET username = 'admin'
            WHERE username IS NULL
               OR TRIM(username) = ''
            """
        )

        # Commit column migrations before rebuilding related tables.
        conn.commit()

        # Rebuild the child tables only when old databases do not
        # contain ON DELETE CASCADE.
        _migrate_evaluation_results_cascade(cursor)
        _migrate_conversation_history_cascade(cursor)

        # ── LLM and Realtime Model Usage Telemetry ──────────────
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,

                event_id TEXT NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                completed_at TEXT,

                username TEXT,
                session_id TEXT,
                request_id TEXT,

                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                feature TEXT NOT NULL,

                text_input_tokens INTEGER NOT NULL DEFAULT 0,
                text_output_tokens INTEGER NOT NULL DEFAULT 0,
                audio_input_tokens INTEGER NOT NULL DEFAULT 0,
                audio_output_tokens INTEGER NOT NULL DEFAULT 0,

                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,

                text_input_cost REAL NOT NULL DEFAULT 0,
                text_output_cost REAL NOT NULL DEFAULT 0,
                audio_input_cost REAL NOT NULL DEFAULT 0,
                audio_output_cost REAL NOT NULL DEFAULT 0,
                total_cost REAL NOT NULL DEFAULT 0,

                currency TEXT NOT NULL DEFAULT 'USD',
                latency_ms REAL,
                duration_seconds REAL,

                status TEXT NOT NULL DEFAULT 'success',
                error_type TEXT,
                usage_source TEXT NOT NULL DEFAULT 'provider',

                voice_id TEXT,
                metadata_json TEXT
            )
            """
        )

        # ── Telemetry Indexes ────────────────────────────────────
        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_llm_usage_username_timestamp
            ON llm_usage(username, timestamp)
            """
        )

        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_llm_usage_model_timestamp
            ON llm_usage(model, timestamp)
            """
        )

        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_llm_usage_feature_timestamp
            ON llm_usage(feature, timestamp)
            """
        )

        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_llm_usage_session_id
            ON llm_usage(session_id)
            """
        )

        # ── Session and User Indexes ─────────────────────────────
        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_practice_sessions_username_timestamp
            ON practice_sessions(username, timestamp)
            """
        )

        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_evaluation_results_session_username
            ON evaluation_results(session_id, username)
            """
        )

        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS
                idx_conversation_history_session_username
            ON conversation_history(session_id, username)
            """
        )

        # Drop deprecated tables.
        cursor.execute("DROP TABLE IF EXISTS users")
        cursor.execute("DROP TABLE IF EXISTS rate_limits")

        conn.commit()

        logger.info("Database initialized successfully")


_POSTGRES_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS practice_sessions (
        session_id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT 'admin',
        timestamp TEXT NOT NULL,
        difficulty_level TEXT NOT NULL
            CHECK (difficulty_level IN ('Easy', 'Medium', 'Hard', 'Expert')),
        client_persona TEXT,
        industry TEXT,
        company_size TEXT,
        total_practice_time INTEGER,
        document_alignment DOUBLE PRECISION,
        average_score DOUBLE PRECISION,
        scenario_type TEXT DEFAULT 'Sales & Commercial Pitches',
        business_context TEXT DEFAULT 'Consulting',
        response_language TEXT DEFAULT 'en'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS evaluation_results (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES practice_sessions(session_id) ON DELETE CASCADE,
        username TEXT NOT NULL DEFAULT 'admin',
        overall_score DOUBLE PRECISION,
        report_text TEXT,
        dimension_scores TEXT,
        timestamp TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS conversation_history (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES practice_sessions(session_id) ON DELETE CASCADE,
        username TEXT NOT NULL DEFAULT 'admin',
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS llm_usage (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        completed_at TEXT,
        username TEXT,
        session_id TEXT,
        request_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        feature TEXT NOT NULL,
        text_input_tokens INTEGER NOT NULL DEFAULT 0,
        text_output_tokens INTEGER NOT NULL DEFAULT 0,
        audio_input_tokens INTEGER NOT NULL DEFAULT 0,
        audio_output_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        text_input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        text_output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        audio_input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        audio_output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        latency_ms DOUBLE PRECISION,
        duration_seconds DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'success',
        error_type TEXT,
        usage_source TEXT NOT NULL DEFAULT 'provider',
        voice_id TEXT,
        metadata_json TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_llm_usage_username_timestamp ON llm_usage(username, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_llm_usage_model_timestamp ON llm_usage(model, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_llm_usage_feature_timestamp ON llm_usage(feature, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_llm_usage_session_id ON llm_usage(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_practice_sessions_username_timestamp ON practice_sessions(username, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_evaluation_results_session_username ON evaluation_results(session_id, username)",
    "CREATE INDEX IF NOT EXISTS idx_conversation_history_session_username ON conversation_history(session_id, username)",
]


def _init_postgres() -> None:
    """Create the PostgreSQL schema (idempotent; the same tables and indexes as SQLite)."""
    with db_connection() as conn:
        cursor = conn.cursor()
        for statement in _POSTGRES_SCHEMA:
            cursor.execute(statement)
        conn.commit()
    logger.info("PostgreSQL database initialized successfully")


def check_database_health() -> dict:
    """Check database connectivity and return health information."""
    try:
        with db_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT 1")

            cursor.execute(
                "SELECT COUNT(*) FROM practice_sessions"
            )
            session_count = int(cursor.fetchone()[0])

            if IS_POSTGRES:
                cursor.execute(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'llm_usage'"
                )
            else:
                cursor.execute(
                    """
                    SELECT COUNT(*)
                    FROM sqlite_master
                    WHERE type = 'table'
                      AND name = 'llm_usage'
                    """
                )
            telemetry_table_exists = bool(cursor.fetchone()[0])

            telemetry_count = 0

            if telemetry_table_exists:
                cursor.execute("SELECT COUNT(*) FROM llm_usage")
                telemetry_count = int(cursor.fetchone()[0])

            return {
                "status": "healthy",
                "backend": database_backend(),
                "session_count": session_count,
                "telemetry_table_exists": telemetry_table_exists,
                "telemetry_record_count": telemetry_count,
            }

    except Exception as exc:
        logger.exception(
            "Database health check failed: %s",
            exc,
        )

        return {
            "status": "unhealthy",
            "error": str(exc),
        }
# """
# Shared Database Module for Sales Coach API
# Provides consistent database access across all routers with proper connection management.
# """
# import sqlite3
# import os
# from contextlib import contextmanager
# from typing import Optional

# from api.core.config import DATABASE_PATH
# from shared_logger import get_logger

# logger = get_logger(__name__)


# def get_db_path() -> str:
#     """Return the absolute path to the SQLite database file."""
#     return os.path.abspath(DATABASE_PATH)


# # def get_db_connection() -> sqlite3.Connection:
# #     """
# #     Get a database connection with row factory set to return dictionaries.
# #     Enables WAL mode for better concurrent read performance.
# #     """
# #     conn = sqlite3.connect(get_db_path())
# #     conn.row_factory = sqlite3.Row
# #     # Enable WAL mode for better concurrent access
# #     conn.execute("PRAGMA journal_mode=WAL")
# #     # Enable foreign keys
# #     conn.execute("PRAGMA foreign_keys=ON")
# #     return conn
# def get_db_connection() -> sqlite3.Connection:
#     """
#     Get a database connection with dictionary-style rows and
#     concurrency-friendly SQLite settings.
#     """
#     conn = sqlite3.connect(
#         get_db_path(),
#         timeout=30.0,
#     )
#     conn.row_factory = sqlite3.Row

#     conn.execute("PRAGMA journal_mode=WAL")
#     conn.execute("PRAGMA foreign_keys=ON")
#     conn.execute("PRAGMA busy_timeout=30000")

#     return conn

# @contextmanager
# def db_connection():
#     """
#     Context manager for database connections.
#     Ensures connections are properly closed even on errors.

#     Usage:
#         with db_connection() as conn:
#             cursor = conn.cursor()
#             cursor.execute(...)
#     """
#     conn = get_db_connection()
#     try:
#         yield conn
#     except Exception:
#         conn.rollback()
#         raise
#     finally:
#         conn.close()


# def init_database() -> None:
#     """
#     Initialize the database and create all tables if they don't exist.
#     Also runs migrations to add `username` column to existing tables.
#     This is the single source of truth for database schema.
#     """
#     with db_connection() as conn:
#         cursor = conn.cursor()

#         # ── Practice Sessions ────────────────────────────────────
#         cursor.execute("""
#             CREATE TABLE IF NOT EXISTS practice_sessions (
#                 session_id TEXT PRIMARY KEY,
#                 username TEXT NOT NULL DEFAULT 'admin',
#                 timestamp TEXT NOT NULL,
#                 difficulty_level TEXT NOT NULL
#                     CHECK(difficulty_level IN ('Easy', 'Medium', 'Hard', 'Expert')),
#                 client_persona TEXT,
#                 industry TEXT,
#                 company_size TEXT,
#                 total_practice_time INTEGER,
#                 document_alignment REAL,
#                 average_score REAL,
#                 scenario_type TEXT DEFAULT 'Sales & Commercial Pitches',
#                 business_context TEXT DEFAULT 'Consulting',
#                 response_language TEXT DEFAULT 'en'
#             )
#         """)

#         # ── Evaluation Results ───────────────────────────────────
#         cursor.execute("""
#             CREATE TABLE IF NOT EXISTS evaluation_results (
#                 id INTEGER PRIMARY KEY AUTOINCREMENT,
#                 session_id TEXT NOT NULL,
#                 username TEXT NOT NULL DEFAULT 'admin',
#                 overall_score REAL,
#                 report_text TEXT,
#                 dimension_scores TEXT,
#                 timestamp TEXT NOT NULL,
#                 FOREIGN KEY (session_id) REFERENCES practice_sessions(session_id) ON DELETE CASCADE
#             )
#         """)

#         # ── Conversation History ─────────────────────────────────
#         cursor.execute("""
#             CREATE TABLE IF NOT EXISTS conversation_history (
#                 id INTEGER PRIMARY KEY AUTOINCREMENT,
#                 session_id TEXT NOT NULL,
#                 username TEXT NOT NULL DEFAULT 'admin',
#                 message_index INTEGER NOT NULL,
#                 role TEXT NOT NULL CHECK(role IN ('user', 'ai')),
#                 content TEXT NOT NULL,
#                 timestamp TEXT NOT NULL,
#                 FOREIGN KEY (session_id) REFERENCES practice_sessions(session_id) ON DELETE CASCADE
#             )
#         """)
#         # ── LLM and Realtime Model Usage Telemetry ──────────────
#         cursor.execute("""
#             CREATE TABLE IF NOT EXISTS llm_usage (
#                 id INTEGER PRIMARY KEY AUTOINCREMENT,

#                 event_id TEXT NOT NULL UNIQUE,
#                 timestamp TEXT NOT NULL,
#                 completed_at TEXT,

#                 username TEXT,
#                 session_id TEXT,
#                 request_id TEXT,

#                 provider TEXT NOT NULL,
#                 model TEXT NOT NULL,
#                 feature TEXT NOT NULL,

#                 text_input_tokens INTEGER NOT NULL DEFAULT 0,
#                 text_output_tokens INTEGER NOT NULL DEFAULT 0,
#                 audio_input_tokens INTEGER NOT NULL DEFAULT 0,
#                 audio_output_tokens INTEGER NOT NULL DEFAULT 0,

#                 prompt_tokens INTEGER NOT NULL DEFAULT 0,
#                 completion_tokens INTEGER NOT NULL DEFAULT 0,
#                 total_tokens INTEGER NOT NULL DEFAULT 0,
#                 reasoning_tokens INTEGER NOT NULL DEFAULT 0,

#                 text_input_cost REAL NOT NULL DEFAULT 0,
#                 text_output_cost REAL NOT NULL DEFAULT 0,
#                 audio_input_cost REAL NOT NULL DEFAULT 0,
#                 audio_output_cost REAL NOT NULL DEFAULT 0,
#                 total_cost REAL NOT NULL DEFAULT 0,

#                 currency TEXT NOT NULL DEFAULT 'USD',
#                 latency_ms REAL,
#                 duration_seconds REAL,

#                 status TEXT NOT NULL DEFAULT 'success',
#                 error_type TEXT,
#                 usage_source TEXT NOT NULL DEFAULT 'provider',

#                 voice_id TEXT,
#                 metadata_json TEXT
#             )
#         """)

#         cursor.execute("""
#             CREATE INDEX IF NOT EXISTS idx_llm_usage_username_timestamp
#             ON llm_usage(username, timestamp)
#         """)

#         cursor.execute("""
#             CREATE INDEX IF NOT EXISTS idx_llm_usage_model_timestamp
#             ON llm_usage(model, timestamp)
#         """)

#         cursor.execute("""
#             CREATE INDEX IF NOT EXISTS idx_llm_usage_feature_timestamp
#             ON llm_usage(feature, timestamp)
#         """)

#         cursor.execute("""
#             CREATE INDEX IF NOT EXISTS idx_llm_usage_session_id
#             ON llm_usage(session_id)
#         """)

#         # Drop deprecated phantom users and rate_limits tables
#         cursor.execute("DROP TABLE IF EXISTS users")
#         cursor.execute("DROP TABLE IF EXISTS rate_limits")

#         # Migrate existing tables to include ON DELETE CASCADE if needed
#         cursor.execute("SELECT sql FROM sqlite_master WHERE name='evaluation_results'")
#         row = cursor.fetchone()
#         if row and "ON DELETE CASCADE" not in (row[0] or ""):
#             cursor.execute("PRAGMA foreign_keys=OFF")
#             cursor.execute("""
#                 CREATE TABLE evaluation_results_new (
#                     id INTEGER PRIMARY KEY AUTOINCREMENT,
#                     session_id TEXT NOT NULL,
#                     username TEXT NOT NULL DEFAULT 'admin',
#                     overall_score REAL,
#                     report_text TEXT,
#                     dimension_scores TEXT,
#                     timestamp TEXT NOT NULL,
#                     FOREIGN KEY (session_id) REFERENCES practice_sessions(session_id) ON DELETE CASCADE
#                 )
#             """)
#             cursor.execute("INSERT INTO evaluation_results_new SELECT * FROM evaluation_results")
#             cursor.execute("DROP TABLE evaluation_results")
#             cursor.execute("ALTER TABLE evaluation_results_new RENAME TO evaluation_results")

#         cursor.execute("SELECT sql FROM sqlite_master WHERE name='conversation_history'")
#         row = cursor.fetchone()
#         if row and "ON DELETE CASCADE" not in (row[0] or ""):
#             cursor.execute("PRAGMA foreign_keys=OFF")
#             cursor.execute("""
#                 CREATE TABLE conversation_history_new (
#                     id INTEGER PRIMARY KEY AUTOINCREMENT,
#                     session_id TEXT NOT NULL,
#                     username TEXT NOT NULL DEFAULT 'admin',
#                     message_index INTEGER NOT NULL,
#                     role TEXT NOT NULL CHECK(role IN ('user', 'ai')),
#                     content TEXT NOT NULL,
#                     timestamp TEXT NOT NULL,
#                     FOREIGN KEY (session_id) REFERENCES practice_sessions(session_id) ON DELETE CASCADE
#                 )
#             """)
#             cursor.execute("INSERT INTO conversation_history_new SELECT * FROM conversation_history")
#             cursor.execute("DROP TABLE conversation_history")
#             cursor.execute("ALTER TABLE conversation_history_new RENAME TO conversation_history")
#             cursor.execute("PRAGMA foreign_keys=ON")

#         conn.commit()
#         logger.info("Database initialized successfully")


# def check_database_health() -> dict:
#     """
#     Check database connectivity and return health status.
#     """
#     try:
#         with db_connection() as conn:
#             cursor = conn.cursor()
#             cursor.execute("SELECT 1")
#             cursor.execute("SELECT COUNT(*) FROM practice_sessions")
#             session_count = cursor.fetchone()[0]
#             cursor.execute("SELECT COUNT(*) FROM llm_usage")
#             telemetry_count = cursor.fetchone()[0]
#             return {
#                 "status": "healthy",
#                 "session_count": session_count,
#                 "telemetry_record_count": telemetry_count,
#             }
#     except Exception as e:
#         logger.error(f"Database health check failed: {e}")
#         return {
#             "status": "unhealthy",
#             "error": str(e),
#         }