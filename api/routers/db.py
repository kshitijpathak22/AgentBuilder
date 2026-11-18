"""
Database API Router for Practice Sessions
Provides REST API for managing practice sessions and evaluations.
All data is scoped per-user via the `username` column.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from api.core.auth import User, get_current_user
from api.core.database import IntegrityError, init_database, is_unique_violation
from api.repositories.session_repository import SessionRepository
from shared_logger import get_logger
from api.repositories.telemetry_repository import TelemetryRepository
logger = get_logger(__name__)

router = APIRouter(
    prefix="/db",
    tags=["database"],
)

_session_repo = SessionRepository()
_telemetry_repo = TelemetryRepository()


def get_session_repository() -> SessionRepository:
    """Dependency provider for session repository."""
    return _session_repo


def set_session_repository(repo: SessionRepository) -> None:
    """Set an alternate session repository (for testing/DI)."""
    global _session_repo
    _session_repo = repo


# ============ Pydantic Models ============

class PracticeSessionRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=255)
    timestamp: str
    difficulty_level: str = Field(..., pattern=r"^(Easy|Medium|Hard|Expert)$")
    scenario_type: Optional[str] = Field(None, max_length=255)
    business_context: Optional[str] = Field(None, max_length=255)
    response_language: Optional[str] = Field(None, max_length=50)
    client_persona: Optional[str] = Field(None, max_length=255)
    industry: Optional[str] = Field(None, max_length=255)
    company_size: Optional[str] = Field(None, max_length=255)
    total_practice_time: Optional[int] = Field(None, ge=0)
    document_alignment: Optional[float] = Field(None, ge=0.0, le=100.0)
    average_score: Optional[float] = Field(None, ge=0.0, le=100.0)


class EvaluationResultRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=255)
    overall_score: float = Field(..., ge=0.0, le=100.0)
    report_text: str
    dimension_scores: Dict[str, float]
    timestamp: Optional[str] = None
    total_practice_time: Optional[int] = Field(None, ge=0)


class ConversationHistoryRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=255)
    messages: List[Dict[str, Any]]


class StatusResponse(BaseModel):
    status: str
    message: Optional[str] = None
    session_id: Optional[str] = None


class ScoreResponse(BaseModel):
    date: str
    score: Optional[float]


class SessionResponse(BaseModel):
    session_id: str
    username: str
    timestamp: str
    difficulty_level: str
    scenario_type: Optional[str] = None
    business_context: Optional[str] = None
    response_language: Optional[str] = None
    client_persona: Optional[str] = None
    industry: Optional[str] = None
    company_size: Optional[str] = None
    total_practice_time: Optional[int] = None
    document_alignment: Optional[float] = None
    average_score: Optional[float] = None
    evaluation: Optional[Dict[str, Any]] = None


class StatisticsResponse(BaseModel):
    total_sessions: int
    average_score: float
    average_by_difficulty: Dict[str, Dict[str, Any]]
    sessions_by_difficulty: Dict[str, int]
    average_practice_time: float
    total_practice_time: int


class ClarityResponse(BaseModel):
    latest: Optional[float]
    average: Optional[float]


class DimensionsSummaryResponse(BaseModel):
    latest_dimensions: Optional[Dict[str, Optional[float]]]
    average_dimensions: Dict[str, Optional[float]]
    sessions_included: int


class ConversationResponse(BaseModel):
    session_id: str
    messages: List[Dict[str, Any]]
    message_count: int


class AdminUserStats(BaseModel):
    username: str
    created_at: Optional[str] = None
    session_count: int
    average_score: Optional[float] = None
    total_practice_time: Optional[int] = None


class AdminOverviewResponse(BaseModel):
    total_users: int
    total_sessions: int
    total_evaluations: int
    total_conversations: int
    users: List[AdminUserStats]


class AdminAllSessionsResponse(BaseModel):
    sessions: List[SessionResponse]


def _require_admin(current_user: User) -> User:
    if current_user.role not in ("admin", "developer") and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user


# ============ API Endpoints ============

@router.get("/", response_model=StatusResponse)
def db_root(current_user: User = Depends(get_current_user)):
    """Database API root endpoint."""
    logger.info("Database API root endpoint called by: %s", current_user.email)
    return StatusResponse(
        status="ok",
        message="Practice Session Database API v2.0",
    )


@router.post("/init", response_model=StatusResponse)
def init_db(current_user: User = Depends(get_current_user)):
    """Initialize the database (admin only)."""
    _require_admin(current_user)
    logger.info("Database initialization endpoint called by: %s", current_user.email)
    init_database()
    logger.info("Database initialized successfully")
    return StatusResponse(status="success", message="Database initialized")


@router.post("/sessions", response_model=StatusResponse)
def save_practice_session(
    session: PracticeSessionRequest,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Save a new practice session to the database (scoped to current user)."""
    logger.info(
        "Saving practice session: %s for user: %s",
        session.session_id,
        current_user.email,
    )
    try:
        repo.save_practice_session(
            session_id=session.session_id,
            username=current_user.email,
            timestamp=session.timestamp,
            difficulty_level=session.difficulty_level,
            client_persona=session.client_persona,
            industry=session.industry,
            company_size=session.company_size,
            total_practice_time=session.total_practice_time,
            document_alignment=session.document_alignment,
            average_score=session.average_score,
            scenario_type=session.scenario_type,
            business_context=session.business_context,
            response_language=session.response_language,
        )
        logger.info("Practice session saved: %s", session.session_id)
        return StatusResponse(status="success", session_id=session.session_id)
    except IntegrityError as e:
        logger.warning("Integrity error saving session %s: %s", session.session_id, str(e))
        if is_unique_violation(e):
            raise HTTPException(
                status_code=400, detail=f"Session {session.session_id} already exists"
            )
        raise


@router.post("/evaluations", response_model=StatusResponse)
def save_evaluation_result(
    evaluation: EvaluationResultRequest,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Save evaluation results after a practice session (scoped to current user)."""
    logger.info(
        "Saving evaluation for session: %s by user: %s",
        evaluation.session_id,
        current_user.email,
    )
    repo.save_evaluation_result(
        session_id=evaluation.session_id,
        username=current_user.email,
        overall_score=evaluation.overall_score,
        report_text=evaluation.report_text,
        dimension_scores=evaluation.dimension_scores,
        timestamp=evaluation.timestamp,
        total_practice_time=evaluation.total_practice_time,
    )
    logger.info("Evaluation saved for session: %s", evaluation.session_id)
    return StatusResponse(status="success", session_id=evaluation.session_id)


@router.get("/sessions")
def get_recent_sessions(
    limit: Optional[int] = Query(None, ge=1, le=100),
    difficulty: Optional[str] = Query(None, pattern=r"^(Easy|Medium|Hard|Expert)$"),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get recent practice sessions for the current user."""
    logger.info(
        "Get sessions called. User: %s, Limit: %s, Difficulty: %s",
        current_user.email,
        limit,
        difficulty,
    )
    result = repo.get_recent_sessions(
        username=current_user.email,
        difficulty=difficulty,
        limit=limit,
    )
    logger.info("Returning %d sessions", len(result))
    return result


@router.get("/sessions/scores", response_model=List[ScoreResponse])
def get_session_scores(
    limit: int = Query(10, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get only final scores and dates for past N sessions for the current user."""
    logger.info(
        "Get session scores called. User: %s, Limit: %d",
        current_user.email,
        limit,
    )
    scores = [
        ScoreResponse(date=row["date"], score=row["score"])
        for row in repo.get_session_scores(current_user.email, limit)
    ]
    logger.info("Returning %d session scores", len(scores))
    return scores


@router.get("/sessions_difficulty")
def get_sessions_by_difficulty(
    limit: int = Query(10, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get past sessions grouped by difficulty level for the current user."""
    logger.info(
        "Get sessions by difficulty called. User: %s, Limit: %d",
        current_user.email,
        limit,
    )
    result = repo.get_sessions_by_difficulty(current_user.email, limit)
    total = sum(len(s) for s in result.values())
    logger.info("Returning sessions by difficulty. Total: %d", total)
    return result


@router.get("/sessions/{session_id}")
def get_session_by_id(
    session_id: str,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get a specific practice session by ID (scoped to current user)."""
    logger.info(
        "Get session by ID: %s, User: %s", session_id, current_user.email
    )
    session = repo.get_session_by_id(session_id, current_user.email)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete("/sessions/last", response_model=StatusResponse)
def delete_last_session(
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Delete the most recent practice session (scoped to current user)."""
    logger.info("Delete last session called by: %s", current_user.email)
    deleted_id = repo.delete_last_session(current_user.email)
    if not deleted_id:
        raise HTTPException(status_code=404, detail="No sessions found to delete")
    logger.info("Last session deleted: %s", deleted_id)
    return StatusResponse(
        status="success",
        message="Last session deleted successfully",
        session_id=deleted_id,
    )


@router.get("/statistics", response_model=StatisticsResponse)
def get_statistics(
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get overall statistics about practice sessions for the current user."""
    logger.info("Get statistics called by: %s", current_user.email)
    stats = repo.get_statistics(current_user.email)
    logger.info(
        "Statistics: %d sessions, avg score: %.2f",
        stats["total_sessions"],
        stats["average_score"],
    )
    return StatisticsResponse(**stats)


# ── Admin endpoints ──────────────────────────────────────────────

@router.get("/admin/overview", response_model=AdminOverviewResponse)
def admin_overview(
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Admin-only: Get global app overview with all users and aggregate stats."""
    _require_admin(current_user)
    logger.info("Admin overview requested by: %s", current_user.email)
    data = repo.admin_overview()
    user_stats = [AdminUserStats(**u) for u in data["users"]]
    return AdminOverviewResponse(
        total_users=data["total_users"],
        total_sessions=data["total_sessions"],
        total_evaluations=data["total_evaluations"],
        total_conversations=data["total_conversations"],
        users=user_stats,
    )


@router.get("/admin/sessions", response_model=AdminAllSessionsResponse)
def admin_all_sessions(
    limit: int = Query(100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Admin-only: Get all practice sessions across all users."""
    _require_admin(current_user)
    logger.info("Admin all sessions requested by: %s", current_user.email)
    sessions = [
        SessionResponse(**s) for s in repo.admin_all_sessions(limit)
    ]
    return AdminAllSessionsResponse(sessions=sessions)


@router.get("/admin/evaluations")
def admin_all_evaluations(
    limit: int = Query(100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Admin-only: Get all evaluation results across all users."""
    _require_admin(current_user)
    logger.info("Admin all evaluations requested by: %s", current_user.email)
    return repo.admin_all_evaluations(limit)


@router.get("/admin/conversations")
def admin_all_conversations(
    limit: int = Query(100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Admin-only: Get all conversation history across all users."""
    _require_admin(current_user)
    logger.info("Admin all conversations requested by: %s", current_user.email)
    return repo.admin_all_conversations(limit)


@router.post("/admin/init", response_model=StatusResponse)
def admin_init_db(current_user: User = Depends(get_current_user)):
    """Admin-only: Initialize the database (create tables if not exist)."""
    _require_admin(current_user)
    logger.info("Admin db init requested by: %s", current_user.email)
    init_database()
    logger.info("Database initialized successfully by admin")
    return StatusResponse(status="success", message="Database initialized")


@router.get("/admin/conversations/{session_id}", response_model=ConversationResponse)
def admin_get_conversation(
    session_id: str,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Admin-only: Get conversation history for any session."""
    _require_admin(current_user)
    logger.info("Admin get conversation for session: %s", session_id)
    messages = repo.admin_get_conversation(session_id)
    return ConversationResponse(
        session_id=session_id,
        messages=messages,
        message_count=len(messages),
    )


@router.delete("/admin/sessions/{session_id}", response_model=StatusResponse)
def admin_delete_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Admin-only: Delete any session and its associated data."""
    _require_admin(current_user)
    logger.info("Admin delete session: %s", session_id)
    deleted = repo.admin_delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    logger.info("Admin deleted session: %s", session_id)
    return StatusResponse(
        status="success",
        message="Session deleted",
        session_id=session_id,
    )


@router.delete("/sessions/{session_id}", response_model=StatusResponse)
def delete_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Delete a specific practice session (scoped to current user)."""
    logger.info(
        "Delete session: %s, User: %s", session_id, current_user.email
    )
    deleted = repo.delete_session(session_id, current_user.email)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    logger.info("Session deleted: %s", session_id)
    return StatusResponse(status="success", session_id=session_id)


@router.get("/evaluations/{session_id}")
def get_session_evaluations(
    session_id: str,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get all evaluations for a specific session (scoped to current user)."""
    logger.info(
        "Get evaluations for session: %s, User: %s",
        session_id,
        current_user.email,
    )
    return repo.get_session_evaluations(session_id, current_user.email)


@router.put("/sessions/{session_id}/score", response_model=StatusResponse)
def update_session_score(
    session_id: str,
    average_score: float = Query(..., ge=0.0, le=100.0),
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Update the average score for a session (scoped to current user)."""
    logger.info(
        "Update score for session: %s to %.1f by: %s",
        session_id,
        average_score,
        current_user.email,
    )
    updated = repo.update_session_score(session_id, average_score, current_user.email)
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    logger.info("Score updated for session: %s", session_id)
    return StatusResponse(status="success", session_id=session_id)


@router.post("/conversations", response_model=StatusResponse)
def save_conversation_history(
    request: ConversationHistoryRequest,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Save conversation history for a practice session (scoped to current user)."""
    logger.info(
        "Saving conversation for session: %s by: %s",
        request.session_id,
        current_user.email,
    )
    saved_count = repo.save_conversation_history(
        session_id=request.session_id,
        messages=request.messages,
        username=current_user.email,
    )
    return StatusResponse(
        status="success",
        session_id=request.session_id,
        message=f"{saved_count} messages saved",
    )


@router.get("/conversations/{session_id}", response_model=ConversationResponse)
def get_conversation_history(
    session_id: str,
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get conversation history for a specific session (scoped to current user)."""
    logger.info(
        "Get conversation for session: %s, User: %s",
        session_id,
        current_user.email,
    )
    messages = repo.get_conversation_history(session_id, current_user.email)
    return ConversationResponse(
        session_id=session_id,
        messages=messages,
        message_count=len(messages),
    )


@router.get("/clarity", response_model=ClarityResponse)
def get_clarity_data(
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get Opening & Engagement (clarity) score from last session and average of last 5."""
    logger.info("Get clarity data called by: %s", current_user.email)
    latest, average = repo.get_clarity_data(current_user.email)
    return ClarityResponse(
        latest=latest,
        average=average,
    )


@router.get("/dimensions/summary", response_model=DimensionsSummaryResponse)
def get_dimensions_summary(
    current_user: User = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repository),
):
    """Get dimension scores from last session and average of last 5 sessions."""
    logger.info("Get dimensions summary called by: %s", current_user.email)
    latest, average, count = repo.get_dimensions_summary(current_user.email)
    return DimensionsSummaryResponse(
        latest_dimensions=latest,
        average_dimensions=average,
        sessions_included=count,
    )

@router.get("/admin/telemetry/overview")
def admin_telemetry_overview(
    current_user: User = Depends(get_current_user),
):
    """Admin-only: Get global token usage and cost overview."""
    _require_admin(current_user)

    logger.info(
        "Admin telemetry overview requested by: %s",
        current_user.email,
    )

    return _telemetry_repo.get_usage_overview()


@router.get("/admin/telemetry/users")
def admin_telemetry_by_user(
    current_user: User = Depends(get_current_user),
):
    """Admin-only: Get model usage and cost grouped by user."""
    _require_admin(current_user)

    logger.info(
        "Admin telemetry by user requested by: %s",
        current_user.email,
    )

    return {
        "users": _telemetry_repo.get_usage_by_user(),
    }


@router.get("/admin/telemetry/models")
def admin_telemetry_by_model(
    current_user: User = Depends(get_current_user),
):
    """Admin-only: Get usage and cost grouped by model."""
    _require_admin(current_user)

    logger.info(
        "Admin telemetry by model requested by: %s",
        current_user.email,
    )

    return {
        "models": _telemetry_repo.get_usage_by_model(),
    }


@router.get("/admin/telemetry/features")
def admin_telemetry_by_feature(
    current_user: User = Depends(get_current_user),
):
    """Admin-only: Get usage and cost grouped by feature."""
    _require_admin(current_user)

    logger.info(
        "Admin telemetry by feature requested by: %s",
        current_user.email,
    )

    return {
        "features": _telemetry_repo.get_usage_by_feature(),
    }


@router.get("/admin/telemetry/recent")
def admin_recent_telemetry(
    limit: int = Query(100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
):
    """Admin-only: Get recent individual usage records."""
    _require_admin(current_user)

    logger.info(
        "Admin recent telemetry requested by: %s",
        current_user.email,
    )

    return {
        "usage": _telemetry_repo.get_recent_usage(limit),
    }