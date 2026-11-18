"""
Session Repository - Data Access Layer for Practice Sessions and Evaluations.
Encapsulates all SQL queries, transaction management, and JSON serialization.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from api.core.database import db_connection
from shared_logger import get_logger

logger = get_logger(__name__)

UNIVERSAL_DIMENSIONS: List[str] = [
    "Communication",
    "Discovery Skills",
    "Business Acumen",
    "Relationship Building",
    "Executive Presence",
    "Problem Solving",
    "Influence & Persuasion",
    "Action Orientation & Next Steps",
]
DIMENSION_NAMES: List[str] = UNIVERSAL_DIMENSIONS

LEGACY_TO_UNIVERSAL_DIMENSIONS: Dict[str, str] = {
    "Opening & Engagement": "Relationship Building",
    "Discovery": "Discovery Skills",
    "Call-to-action": "Action Orientation & Next Steps",
    "Objection Handling": "Influence & Persuasion",
    "Differentiation": "Problem Solving",
    "Value Proposition": "Business Acumen",
    "Proof and Credibility": "Executive Presence",
    "Communication": "Communication",
    # Snake_case keys from prompts or legacy models
    "opening_and_engagement": "Relationship Building",
    "discovery": "Discovery Skills",
    "call_to_action": "Action Orientation & Next Steps",
    "objection_handling": "Influence & Persuasion",
    "differentiation": "Problem Solving",
    "value_proposition": "Business Acumen",
    "proof_and_credibility": "Executive Presence",
    "communication": "Communication",
    "discovery_skills": "Discovery Skills",
    "business_acumen": "Business Acumen",
    "relationship_building": "Relationship Building",
    "executive_presence": "Executive Presence",
    "problem_solving": "Problem Solving",
    "influence_and_persuasion": "Influence & Persuasion",
    "action_orientation": "Action Orientation & Next Steps",
}


def normalize_dimension_scores(dims: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """Normalize dimension scores to canonical Universal dimension names with float values."""
    if not isinstance(dims, dict):
        return {d: 0.0 for d in UNIVERSAL_DIMENSIONS}
    result: Dict[str, float] = {}
    for key, val in dims.items():
        canonical_key = LEGACY_TO_UNIVERSAL_DIMENSIONS.get(key, key)
        if canonical_key in UNIVERSAL_DIMENSIONS:
            try:
                score = float(val)
                if 0 <= score <= 100:
                    result[canonical_key] = score
            except (ValueError, TypeError):
                pass
    for d in UNIVERSAL_DIMENSIONS:
        if d not in result:
            result[d] = 0.0
    return result


def _safe_json_loads(val: Optional[str]) -> Optional[Any]:
    """Safely parse JSON or return None on error."""
    if not val:
        return None
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def _row_to_session_with_eval(row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Any]:
    """Convert joined row into a session dict with attached evaluation dict."""
    session_dict = {
        "session_id": row["session_id"],
        "username": row["username"],
        "timestamp": row["timestamp"],
        "difficulty_level": row["difficulty_level"],
        "client_persona": row["client_persona"],
        "industry": row["industry"],
        "company_size": row["company_size"],
        "total_practice_time": row["total_practice_time"],
        "document_alignment": row["document_alignment"],
        "average_score": row["average_score"],
        "scenario_type": row["scenario_type"],
        "business_context": row["business_context"],
        "response_language": row["response_language"],
    }
    if row["eval_id"] is not None:
        raw_dims = _safe_json_loads(row["eval_dimension_scores"])
        session_dict["evaluation"] = {
            "id": row["eval_id"],
            "session_id": row["eval_session_id"] or row["session_id"],
            "username": row["eval_username"],
            "overall_score": row["eval_overall_score"],
            "report_text": row["eval_report_text"],
            "dimension_scores": normalize_dimension_scores(raw_dims) if raw_dims else None,
            "timestamp": row["eval_timestamp"],
        }
    return session_dict


def _attach_latest_evaluation(
    cursor: sqlite3.Cursor, session_dict: Dict[str, Any], username: Optional[str] = None
) -> None:
    """Fetch and attach latest evaluation with parsed dimension_scores to session_dict."""
    session_id = session_dict.get("session_id")
    if username is not None:
        cursor.execute(
            """
            SELECT * FROM evaluation_results
            WHERE session_id = ? AND username = ?
            ORDER BY timestamp DESC, id DESC LIMIT 1
            """,
            (session_id, username),
        )
    else:
        cursor.execute(
            """
            SELECT * FROM evaluation_results
            WHERE session_id = ?
            ORDER BY timestamp DESC, id DESC LIMIT 1
            """,
            (session_id,),
        )
    evaluation = cursor.fetchone()
    if evaluation:
        eval_dict = dict(evaluation)
        raw_dims = _safe_json_loads(eval_dict.get("dimension_scores"))
        eval_dict["dimension_scores"] = normalize_dimension_scores(raw_dims) if raw_dims else None
        session_dict["evaluation"] = eval_dict


class SessionRepository:
    """Repository handling all database operations for practice sessions."""

    def save_practice_session(
        self,
        session_id: str,
        username: str,
        timestamp: str,
        difficulty_level: str,
        client_persona: Optional[str],
        industry: Optional[str],
        company_size: Optional[str],
        total_practice_time: Optional[int],
        document_alignment: Optional[float],
        average_score: Optional[float],
        scenario_type: Optional[str] = "Sales & Commercial Pitches",
        business_context: Optional[str] = "Consulting",
        response_language: Optional[str] = "en",
    ) -> str:
        """Insert a practice session, returning session_id. Raises api.core.database.IntegrityError on conflict."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO practice_sessions (
                    session_id, username, timestamp, difficulty_level, client_persona,
                    industry, company_size, total_practice_time,
                    document_alignment, average_score, scenario_type,
                    business_context, response_language
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    username,
                    timestamp,
                    difficulty_level,
                    client_persona,
                    industry,
                    company_size,
                    total_practice_time,
                    document_alignment,
                    average_score,
                    scenario_type or "Sales & Commercial Pitches",
                    business_context or "Consulting",
                    response_language or "en",
                ),
            )
            conn.commit()
            return session_id

    def save_evaluation_result(
        self,
        session_id: str,
        username: str,
        overall_score: float,
        report_text: str,
        dimension_scores: Dict[str, float],
        timestamp: Optional[str] = None,
        total_practice_time: Optional[int] = None,
    ) -> str:
        """Insert evaluation results and update practice session score/time."""
        ts = timestamp or datetime.now().isoformat()
        normalized_dims = normalize_dimension_scores(dimension_scores)
        dimension_scores_json = json.dumps(normalized_dims)

        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO evaluation_results (
                    session_id, username, overall_score, report_text, dimension_scores, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    username,
                    overall_score,
                    report_text,
                    dimension_scores_json,
                    ts,
                ),
            )
            cursor.execute(
                """
                UPDATE practice_sessions
                SET average_score = ?,
                    total_practice_time = COALESCE(?, total_practice_time)
                WHERE session_id = ? AND username = ?
                """,
                (
                    overall_score,
                    total_practice_time,
                    session_id,
                    username,
                ),
            )
            conn.commit()
            return session_id

    def get_recent_sessions(
        self,
        username: str,
        difficulty: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Get recent practice sessions with their latest evaluations in a single query."""
        with db_connection() as conn:
            cursor = conn.cursor()
            query = """
                SELECT 
                    ps.session_id,
                    ps.username,
                    ps.timestamp,
                    ps.difficulty_level,
                    ps.client_persona,
                    ps.industry,
                    ps.company_size,
                    ps.total_practice_time,
                    ps.document_alignment,
                    ps.average_score,
                    ps.scenario_type,
                    ps.business_context,
                    ps.response_language,
                    er.id AS eval_id,
                    er.session_id AS eval_session_id,
                    er.username AS eval_username,
                    er.overall_score AS eval_overall_score,
                    er.report_text AS eval_report_text,
                    er.dimension_scores AS eval_dimension_scores,
                    er.timestamp AS eval_timestamp
                FROM practice_sessions ps
                LEFT JOIN evaluation_results er ON er.id = (
                    SELECT id FROM evaluation_results
                    WHERE session_id = ps.session_id
                    ORDER BY timestamp DESC, id DESC
                    LIMIT 1
                )
                WHERE ps.username = ?
            """
            params: List[Any] = [username]

            if difficulty:
                query += " AND ps.difficulty_level = ?"
                params.append(difficulty)

            query += " ORDER BY ps.timestamp DESC"
            if limit:
                query += " LIMIT ?"
                params.append(limit)

            cursor.execute(query, tuple(params))
            return [_row_to_session_with_eval(row) for row in cursor.fetchall()]

    def get_session_scores(self, username: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Get past N session timestamps and average scores for a user."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT timestamp, average_score
                FROM practice_sessions
                WHERE username = ? AND average_score IS NOT NULL
                ORDER BY timestamp DESC LIMIT ?
                """,
                (username, limit),
            )
            return [
                {"date": row["timestamp"], "score": row["average_score"]}
                for row in cursor.fetchall()
            ]

    def get_sessions_by_difficulty(
        self, username: str, limit: int = 10
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Get past sessions grouped by difficulty level for a user."""
        with db_connection() as conn:
            cursor = conn.cursor()
            difficulty_levels = ["Easy", "Medium", "Hard", "Expert"]
            result = {}

            for difficulty in difficulty_levels:
                cursor.execute(
                    """
                    SELECT timestamp, average_score
                    FROM practice_sessions
                    WHERE username = ? AND difficulty_level = ? AND average_score IS NOT NULL
                    ORDER BY timestamp DESC LIMIT ?
                    """,
                    (username, difficulty, limit),
                )
                result[difficulty] = [
                    {"date": row["timestamp"], "score": row["average_score"]}
                    for row in cursor.fetchall()
                ]
            return result

    def get_session_by_id(
        self, session_id: str, username: str
    ) -> Optional[Dict[str, Any]]:
        """Get a specific practice session by ID with its latest evaluation in a single query."""
        with db_connection() as conn:
            cursor = conn.cursor()
            query = """
                SELECT 
                    ps.session_id,
                    ps.username,
                    ps.timestamp,
                    ps.difficulty_level,
                    ps.client_persona,
                    ps.industry,
                    ps.company_size,
                    ps.total_practice_time,
                    ps.document_alignment,
                    ps.average_score,
                    ps.scenario_type,
                    ps.business_context,
                    ps.response_language,
                    er.id AS eval_id,
                    er.session_id AS eval_session_id,
                    er.username AS eval_username,
                    er.overall_score AS eval_overall_score,
                    er.report_text AS eval_report_text,
                    er.dimension_scores AS eval_dimension_scores,
                    er.timestamp AS eval_timestamp
                FROM practice_sessions ps
                LEFT JOIN evaluation_results er ON er.id = (
                    SELECT id FROM evaluation_results
                    WHERE session_id = ps.session_id
                    ORDER BY timestamp DESC, id DESC
                    LIMIT 1
                )
                WHERE ps.session_id = ? AND ps.username = ?
            """
            cursor.execute(query, (session_id, username))
            row = cursor.fetchone()
            if not row:
                return None
            return _row_to_session_with_eval(row)

    def get_recent_evaluated_sessions(
        self, username: str, limit: int = 5
    ) -> List[Dict[str, Any]]:
        """Fetch past completed sessions with their evaluation reports for AI analysis."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT ps.session_id, ps.timestamp, ps.difficulty_level,
                       ps.client_persona, ps.average_score,
                       er.report_text, er.dimension_scores, er.overall_score
                FROM practice_sessions ps
                LEFT JOIN evaluation_results er
                    ON ps.session_id = er.session_id AND ps.username = er.username
                WHERE ps.username = ? AND er.report_text IS NOT NULL
                ORDER BY ps.timestamp DESC
                LIMIT ?
                """,
                (username, limit),
            )
            sessions = []
            for row in cursor.fetchall():
                session = dict(row)
                raw_dims = _safe_json_loads(session.get("dimension_scores"))
                session["dimension_scores"] = (
                    normalize_dimension_scores(raw_dims) if raw_dims else {}
                )
                sessions.append(session)
            return sessions

    def delete_last_session(self, username: str) -> Optional[str]:
        """Delete the most recent practice session and associated records via cascade delete."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT session_id FROM practice_sessions
                WHERE username = ?
                ORDER BY timestamp DESC LIMIT 1
                """,
                (username,),
            )
            last_session = cursor.fetchone()
            if not last_session:
                return None

            session_id = last_session["session_id"]
            cursor.execute(
                "DELETE FROM practice_sessions WHERE session_id = ? AND username = ?",
                (session_id, username),
            )
            conn.commit()
            return session_id

    def delete_session(self, session_id: str, username: str) -> bool:
        """Delete a specific practice session and its associated data via cascade delete."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM practice_sessions WHERE session_id = ? AND username = ?",
                (session_id, username),
            )
            conn.commit()
            return cursor.rowcount > 0

    def get_statistics(self, username: str) -> Dict[str, Any]:
        """Get aggregate statistics about practice sessions for a user."""
        with db_connection() as conn:
            cursor = conn.cursor()

            cursor.execute(
                "SELECT COUNT(*) FROM practice_sessions WHERE username = ?",
                (username,),
            )
            total_sessions = cursor.fetchone()[0]

            cursor.execute(
                """
                SELECT AVG(average_score) FROM practice_sessions
                WHERE username = ? AND average_score IS NOT NULL
                """,
                (username,),
            )
            avg_score = cursor.fetchone()[0] or 0

            cursor.execute(
                """
                SELECT difficulty_level, COUNT(*), AVG(average_score)
                FROM practice_sessions
                WHERE username = ? AND average_score IS NOT NULL
                GROUP BY difficulty_level
                """,
                (username,),
            )

            average_by_difficulty: Dict[str, Dict[str, Any]] = {}
            sessions_by_difficulty: Dict[str, int] = {}
            for row in cursor.fetchall():
                difficulty, count, avg = row[0], row[1], row[2] or 0
                average_by_difficulty[difficulty] = {
                    "average_score": round(avg, 2),
                    "session_count": count,
                }
                sessions_by_difficulty[difficulty] = count

            cursor.execute(
                """
                SELECT SUM(total_practice_time) FROM practice_sessions
                WHERE username = ? AND total_practice_time IS NOT NULL
                """,
                (username,),
            )
            total_time = cursor.fetchone()[0] or 0

            cursor.execute(
                """
                SELECT AVG(total_practice_time) FROM practice_sessions
                WHERE username = ? AND total_practice_time IS NOT NULL
                """,
                (username,),
            )
            avg_time = cursor.fetchone()[0] or 0

            return {
                "total_sessions": total_sessions,
                "average_score": round(avg_score, 2),
                "average_by_difficulty": average_by_difficulty,
                "sessions_by_difficulty": sessions_by_difficulty,
                "average_practice_time": round(avg_time, 2),
                "total_practice_time": total_time,
            }

    def get_session_evaluations(
        self, session_id: str, username: str
    ) -> List[Dict[str, Any]]:
        """Get all evaluations for a specific session."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM evaluation_results
                WHERE session_id = ? AND username = ?
                ORDER BY timestamp DESC
                """,
                (session_id, username),
            )
            evaluations = []
            for row in cursor.fetchall():
                eval_dict = dict(row)
                eval_dict["dimension_scores"] = _safe_json_loads(eval_dict.get("dimension_scores"))
                evaluations.append(eval_dict)
            return evaluations

    def update_session_score(
        self, session_id: str, average_score: float, username: str
    ) -> bool:
        """Update the average score for a session. Returns False if not found."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE practice_sessions SET average_score = ?
                WHERE session_id = ? AND username = ?
                """,
                (average_score, session_id, username),
            )
            if cursor.rowcount == 0:
                return False
            conn.commit()
            return True

    def save_conversation_history(
        self, session_id: str, messages: List[Dict[str, Any]], username: str
    ) -> int:
        """Save conversation history for a session, replacing any earlier copy.

        The frontend sends the whole conversation each time (a save when the user leaves mid-session,
        then the final one on Stop & Evaluate), so replacing keeps exactly one copy of each message.
        """
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM conversation_history WHERE session_id = ? AND username = ?",
                (session_id, username),
            )
            for message in messages:
                ts = message.get("timestamp") or datetime.now().isoformat()
                cursor.execute(
                    """
                    INSERT INTO conversation_history (
                        session_id, username, message_index, role, content, timestamp
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        username,
                        message.get("index", 0),
                        message.get("role", "user"),
                        message.get("content", ""),
                        ts,
                    ),
                )
            conn.commit()
            return len(messages)

    def get_conversation_history(
        self, session_id: str, username: str
    ) -> List[Dict[str, Any]]:
        """Get conversation history for a specific session."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT message_index, role, content, timestamp
                FROM conversation_history
                WHERE session_id = ? AND username = ?
                ORDER BY message_index ASC
                """,
                (session_id, username),
            )
            return [
                {
                    "index": row["message_index"],
                    "role": row["role"],
                    "content": row["content"],
                    "timestamp": row["timestamp"],
                }
                for row in cursor.fetchall()
            ]

    def get_clarity_data(self, username: str) -> Tuple[Optional[float], Optional[float]]:
        """Get Communication / Clarity score from last session and average of last 5."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT er.dimension_scores
                FROM practice_sessions ps
                JOIN evaluation_results er
                    ON ps.session_id = er.session_id AND ps.username = er.username
                WHERE ps.username = ? AND er.dimension_scores IS NOT NULL
                ORDER BY ps.timestamp DESC LIMIT 5
                """,
                (username,),
            )
            rows = cursor.fetchall()
            clarity_scores = []
            for row in rows:
                raw_dims = _safe_json_loads(row[0])
                if isinstance(raw_dims, dict):
                    dims = normalize_dimension_scores(raw_dims)
                    score = dims.get("Communication")
                    if score is not None:
                        clarity_scores.append(float(score))

            latest = clarity_scores[0] if clarity_scores else None
            average = (
                sum(clarity_scores) / len(clarity_scores) if clarity_scores else None
            )
            latest_rounded = round(latest, 1) if latest is not None else None
            average_rounded = round(average, 1) if average is not None else None
            return latest_rounded, average_rounded

    def get_dimensions_summary(
        self, username: str
    ) -> Tuple[Optional[Dict[str, Optional[float]]], Dict[str, Optional[float]], int]:
        """Get dimension scores from last session and average of last 5 sessions."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT er.dimension_scores
                FROM practice_sessions ps
                JOIN evaluation_results er
                    ON ps.session_id = er.session_id AND ps.username = er.username
                WHERE ps.username = ? AND er.dimension_scores IS NOT NULL
                ORDER BY ps.timestamp DESC LIMIT 5
                """,
                (username,),
            )
            rows = cursor.fetchall()

            dimension_sums = {name: 0.0 for name in UNIVERSAL_DIMENSIONS}
            dimension_counts = {name: 0 for name in UNIVERSAL_DIMENSIONS}
            latest_dimensions: Optional[Dict[str, Optional[float]]] = None

            for idx, row in enumerate(rows):
                raw_dims = _safe_json_loads(row[0])
                if not isinstance(raw_dims, dict):
                    continue

                dimensions = normalize_dimension_scores(raw_dims)

                if idx == 0:
                    latest_dimensions = {
                        name: round(dimensions[name], 1) for name in UNIVERSAL_DIMENSIONS
                    }

                for name in UNIVERSAL_DIMENSIONS:
                    val = dimensions.get(name)
                    if val is not None:
                        dimension_sums[name] += float(val)
                        dimension_counts[name] += 1

            average_dimensions: Dict[str, Optional[float]] = {}
            for name in UNIVERSAL_DIMENSIONS:
                if dimension_counts[name] > 0:
                    average_dimensions[name] = round(
                        dimension_sums[name] / dimension_counts[name], 1
                    )
                else:
                    average_dimensions[name] = None

            return latest_dimensions, average_dimensions, len(rows)

    # ── Admin queries ─────────────────────────────────────────────

    def admin_overview(self) -> Dict[str, Any]:
        """Admin overview across all users."""
        from api.core.auth import _load_allowed_users

        with db_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT COUNT(*) FROM practice_sessions")
            total_sessions = cursor.fetchone()[0]

            cursor.execute("SELECT COUNT(*) FROM evaluation_results")
            total_evaluations = cursor.fetchone()[0]

            cursor.execute("SELECT COUNT(*) FROM conversation_history")
            total_conversations = cursor.fetchone()[0]

            # Single aggregated query for all session metrics by username (Fixes N+1)
            cursor.execute("""
                SELECT 
                    username, 
                    COUNT(*) as s_count, 
                    AVG(average_score) as s_avg, 
                    SUM(total_practice_time) as s_time 
                FROM practice_sessions 
                GROUP BY username
            """)
            stats_by_user = {}
            for row in cursor.fetchall():
                u_name = (row["username"] or "").strip().lower()
                stats_by_user[u_name] = {
                    "session_count": row["s_count"] or 0,
                    "average_score": round(row["s_avg"], 2) if row["s_avg"] is not None else None,
                    "total_practice_time": row["s_time"] or 0,
                }

            allowed_users = _load_allowed_users()
            seen_emails = set()
            users = []
            for u in allowed_users:
                email = u["email"].strip().lower()
                seen_emails.add(email)
                st = stats_by_user.get(email, {})
                users.append({
                    "username": u["email"],
                    "created_at": None,
                    "session_count": st.get("session_count", 0),
                    "average_score": st.get("average_score"),
                    "total_practice_time": st.get("total_practice_time", 0),
                })

            for u_name, st in stats_by_user.items():
                if u_name and u_name not in seen_emails:
                    seen_emails.add(u_name)
                    users.append({
                        "username": u_name,
                        "created_at": None,
                        "session_count": st.get("session_count", 0),
                        "average_score": st.get("average_score"),
                        "total_practice_time": st.get("total_practice_time", 0),
                    })

            return {
                "total_users": len(users),
                "total_sessions": total_sessions,
                "total_evaluations": total_evaluations,
                "total_conversations": total_conversations,
                "users": users,
            }

    def admin_all_sessions(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Admin-only: Get all practice sessions across all users with latest evaluations in a single query."""
        with db_connection() as conn:
            cursor = conn.cursor()
            query = """
                SELECT 
                    ps.session_id,
                    ps.username,
                    ps.timestamp,
                    ps.difficulty_level,
                    ps.client_persona,
                    ps.industry,
                    ps.company_size,
                    ps.total_practice_time,
                    ps.document_alignment,
                    ps.average_score,
                    ps.scenario_type,
                    ps.business_context,
                    ps.response_language,
                    er.id AS eval_id,
                    er.session_id AS eval_session_id,
                    er.username AS eval_username,
                    er.overall_score AS eval_overall_score,
                    er.report_text AS eval_report_text,
                    er.dimension_scores AS eval_dimension_scores,
                    er.timestamp AS eval_timestamp
                FROM practice_sessions ps
                LEFT JOIN evaluation_results er ON er.id = (
                    SELECT id FROM evaluation_results
                    WHERE session_id = ps.session_id
                    ORDER BY timestamp DESC, id DESC
                    LIMIT 1
                )
                ORDER BY ps.timestamp DESC LIMIT ?
            """
            cursor.execute(query, (limit,))
            return [_row_to_session_with_eval(row) for row in cursor.fetchall()]

    def admin_all_evaluations(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Admin-only: Get all evaluation results across all users."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM evaluation_results
                ORDER BY timestamp DESC LIMIT ?
                """,
                (limit,),
            )
            evaluations = []
            for row in cursor.fetchall():
                eval_dict = dict(row)
                raw_dims = _safe_json_loads(eval_dict.get("dimension_scores"))
                eval_dict["dimension_scores"] = (
                    normalize_dimension_scores(raw_dims) if raw_dims else None
                )
                evaluations.append(eval_dict)
            return evaluations

    def admin_all_conversations(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Admin-only: Get all conversation history across all users."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT session_id, username, message_index, role, content, timestamp
                FROM conversation_history
                ORDER BY timestamp DESC LIMIT ?
                """,
                (limit,),
            )
            return [
                {
                    "session_id": row["session_id"],
                    "username": row["username"],
                    "message_index": row["message_index"],
                    "role": row["role"],
                    "content": row["content"],
                    "timestamp": row["timestamp"],
                }
                for row in cursor.fetchall()
            ]

    def admin_get_conversation(self, session_id: str) -> List[Dict[str, Any]]:
        """Admin-only: Get conversation history for any session."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT message_index, role, content, timestamp
                FROM conversation_history
                WHERE session_id = ?
                ORDER BY message_index ASC
                """,
                (session_id,),
            )
            return [
                {
                    "index": row["message_index"],
                    "role": row["role"],
                    "content": row["content"],
                    "timestamp": row["timestamp"],
                }
                for row in cursor.fetchall()
            ]

    def admin_delete_session(self, session_id: str) -> bool:
        """Admin-only: Delete any session and its associated data via cascade delete."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM practice_sessions WHERE session_id = ?",
                (session_id,),
            )
            conn.commit()
            return cursor.rowcount > 0
