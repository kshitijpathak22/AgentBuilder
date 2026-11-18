"""
Email-based JWT Authentication for Sales Coach API.
Authorization source is abstracted via an AllowedUsersStore interface.
Supports RBAC with roles: "user", "admin", "developer".
"""
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Callable

from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, EmailStr

from shared_logger import get_logger
from api.core.config import (
    SECRET_KEY,
    ALGORITHM,
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    ALLOWED_USERS_PATH,
)

logger = get_logger(__name__)

VALID_ROLES = ("user", "admin", "developer")

_cached_mtime: float = -1.0
_cached_users: List[dict] = []


# ── OAuth2 scheme ──────────────────────────────────────────────
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


# ── Pydantic Models ────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int
    role: str = "user"
    is_admin: bool = False
    full_name: str = ""


class TokenData(BaseModel):
    email: Optional[str] = None
    role: Optional[str] = None


class User(BaseModel):
    email: str
    full_name: str = ""
    role: str = "user"
    is_admin: bool = False

    @property
    def is_developer(self) -> bool:
        return self.role == "developer"


class LoginRequest(BaseModel):
    email: str


# ── Allowed Users Helpers ──────────────────────────────────────

def _load_allowed_users() -> List[dict]:
    """
    Load the list of allowed users from allowed_users.json.
    Returns a list of {"email": ..., "name": ..., "role": ...} dicts.
    """
    global _cached_mtime, _cached_users
    try:
        if not os.path.exists(ALLOWED_USERS_PATH):
            logger.error("Allowed users file not found: %s", ALLOWED_USERS_PATH)
            _cached_mtime = -1.0
            _cached_users = []
            return []

        mtime = os.path.getmtime(ALLOWED_USERS_PATH)
        if mtime == _cached_mtime:
            return _cached_users

        with open(ALLOWED_USERS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)

        raw = data.get("allowed_users", [])
        result = []
        for entry in raw:
            if isinstance(entry, dict):
                email = (entry.get("email") or "").strip().lower()
                name = (entry.get("name") or "").strip()
                role = (entry.get("role") or "").strip().lower()
                photo = (entry.get("photo") or "").strip()
            else:
                email = str(entry).strip().lower()
                name = ""
                role = ""
                photo = ""

            if role not in VALID_ROLES:
                role = "user"

            if email:
                result.append({"email": email, "name": name, "role": role, "photo": photo})

        _cached_mtime = mtime
        _cached_users = result
        return result
    except (json.JSONDecodeError, OSError) as exc:
        logger.exception("Failed to load allowed users: %s", exc)
        return _cached_users or []


def _is_allowed(email: str) -> bool:
    """Check whether an email is in the allowed users list."""
    allowed = _load_allowed_users()
    return email.strip().lower() in [u["email"] for u in allowed]


def _get_user_record(email: str) -> Optional[dict]:
    """Look up full record for an email."""
    allowed = _load_allowed_users()
    email_lower = email.strip().lower()
    for u in allowed:
        if u["email"] == email_lower:
            return u
    return None


def _get_user_role(email: str) -> str:
    """Look up role for an email. Defaults to 'user'."""
    rec = _get_user_record(email)
    return rec["role"] if rec and rec.get("role") in VALID_ROLES else "user"


def get_user_role(email: str) -> str:
    """Public helper to look up role for an email."""
    return _get_user_role(email)


def _is_admin(email: str) -> bool:
    """Check if the user has the admin or developer role."""
    return _get_user_role(email) in ("admin", "developer")


def _get_user_name(email: str) -> str:
    """Look up the display name for an email."""
    rec = _get_user_record(email)
    return rec["name"] if rec else ""


def get_all_allowed_users() -> List[dict]:
    """Return all allowed users with their role and admin status."""
    allowed = _load_allowed_users()
    if not allowed:
        return []
    result = []
    for u in allowed:
        role = u.get("role", "user")
        result.append({
            "email": u["email"],
            "full_name": u["name"],
            "role": role,
            "is_admin": role in ("admin", "developer"),
            "photo_url": photo_url(u.get("photo", "")),
        })
    return result


def photo_url(photo: str) -> str:
    """API path of a user's profile picture ('' when there is none)."""
    return f"/auth/photos/{photo}" if photo else ""


def get_user_photo(email: str) -> str:
    rec = _get_user_record(email)
    return rec.get("photo", "") if rec else ""


def _write_allowed_users(data: dict) -> None:
    """Write to a temp file and swap it in, so a crash mid-write never leaves a broken user list."""
    tmp_path = f"{ALLOWED_USERS_PATH}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, ALLOWED_USERS_PATH)


def _modify_allowed_users(change: Callable[[list], bool]) -> bool:
    """Read allowed_users.json, let `change` edit the raw list in place, and write it back if it returns True."""
    global _cached_mtime
    try:
        with open(ALLOWED_USERS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw = data.setdefault("allowed_users", [])
        if not change(raw):
            return False
        _write_allowed_users(data)
        _cached_mtime = -1.0  # Invalidate cache
        _load_allowed_users()
        return True
    except (json.JSONDecodeError, OSError) as exc:
        logger.exception("Failed to update %s: %s", ALLOWED_USERS_PATH, exc)
        return False


def add_allowed_user(email: str, name: str, role: str) -> bool:
    """Add a user to allowed_users.json. False if the email is already there."""
    email = email.strip().lower()
    role = role.strip().lower()
    if role not in VALID_ROLES:
        raise ValueError(f"Invalid role '{role}'. Allowed roles: {list(VALID_ROLES)}")
    if _is_allowed(email):
        return False

    def change(raw: list) -> bool:
        raw.append({"email": email, "name": name.strip(), "role": role})
        return True

    return _modify_allowed_users(change)


def remove_allowed_user(email: str) -> bool:
    """Remove a user from allowed_users.json. False if the email was not there."""
    target = email.strip().lower()

    def change(raw: list) -> bool:
        keep = [
            entry for entry in raw
            if ((entry.get("email") if isinstance(entry, dict) else str(entry)) or "").strip().lower() != target
        ]
        if len(keep) == len(raw):
            return False
        raw[:] = keep
        return True

    return _modify_allowed_users(change)


def set_user_photo(email: str, photo: str) -> bool:
    """Record the profile picture file name for an existing user."""
    target = email.strip().lower()

    def change(raw: list) -> bool:
        for i, entry in enumerate(raw):
            entry_email = (entry.get("email") if isinstance(entry, dict) else str(entry)) or ""
            if entry_email.strip().lower() == target:
                if not isinstance(entry, dict):
                    entry = raw[i] = {"email": target, "name": "", "role": "user"}
                entry["photo"] = photo
                return True
        return False

    return _modify_allowed_users(change)


def update_user_role(email: str, role: str) -> bool:
    """Update role for an existing user in allowed_users.json."""
    global _cached_mtime
    target_email = email.strip().lower()
    role = role.strip().lower()
    if role not in VALID_ROLES:
        raise ValueError(f"Invalid role '{role}'. Allowed roles: {list(VALID_ROLES)}")

    if not os.path.exists(ALLOWED_USERS_PATH):
        logger.error("Cannot update user role: file not found %s", ALLOWED_USERS_PATH)
        return False

    try:
        with open(ALLOWED_USERS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)

        raw = data.get("allowed_users", [])
        found = False
        updated_raw = []

        for entry in raw:
            if isinstance(entry, dict):
                entry_email = (entry.get("email") or "").strip().lower()
                if entry_email == target_email:
                    entry["role"] = role
                    found = True
                updated_raw.append(entry)
            else:
                entry_email = str(entry).strip().lower()
                if entry_email == target_email:
                    updated_raw.append({"email": entry_email, "name": "", "role": role})
                    found = True
                else:
                    updated_raw.append(entry)

        if not found:
            return False

        data["allowed_users"] = updated_raw
        _write_allowed_users(data)

        _cached_mtime = -1.0  # Invalidate cache
        _load_allowed_users()
        return True
    except (json.JSONDecodeError, OSError) as exc:
        logger.exception("Failed to update user role in %s: %s", ALLOWED_USERS_PATH, exc)
        return False


# ── Token creation ─────────────────────────────────────────────

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT refresh token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    )
    to_encode.update({"exp": expire, "type": "refresh"})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


# ── Authentication ─────────────────────────────────────────────

def authenticate_by_email(email: str) -> Optional[User]:
    """
    Validate an email against the allowed users list.
    Returns a User object on success, or None if not allowed.
    """
    email = email.strip().lower()
    if not email:
        return None
    if not _is_allowed(email):
        logger.warning("Login attempt with unauthorized email: %s", email)
        return None
    role = _get_user_role(email)
    full_name = _get_user_name(email)
    is_admin = (role in ("admin", "developer"))
    logger.info("Successful login for email: %s (role=%s, admin=%s)", email, role, is_admin)
    return User(email=email, full_name=full_name, role=role, is_admin=is_admin)


# ── Dependency: get current user ───────────────────────────────

async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    """
    FastAPI dependency that extracts and validates the JWT from
    the Authorization header. Raises 401 on failure.
    Also re-validates the email against allowed_users.json so that
    revoking access takes effect immediately.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: Optional[str] = payload.get("sub")
        token_type: Optional[str] = payload.get("type")
        if email is None or token_type != "access":
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Re-check allowed list (handles revoked access)
    if not _is_allowed(email):
        raise credentials_exception

    role = _get_user_role(email)
    full_name = _get_user_name(email)
    return User(email=email, full_name=full_name, role=role, is_admin=(role in ("admin", "developer")))


# ── Dependencies: RBAC ────────────────────────────────────────

def require_role(allowed_roles: List[str]) -> Callable:
    """FastAPI dependency factory enforcing that current user's role is in allowed_roles, or user is developer."""
    async def _role_dependency(current_user: User = Depends(get_current_user)) -> User:
        # Developer role has unrestricted access to all endpoints
        if current_user.role == "developer":
            return current_user
        if current_user.role not in allowed_roles:
            logger.warning(
                "Access forbidden for %s (role=%s, required=%s)",
                current_user.email,
                current_user.role,
                allowed_roles,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access forbidden: requires one of roles {allowed_roles}",
            )
        return current_user
    return _role_dependency


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """FastAPI dependency ensuring current user has admin or developer role."""
    if current_user.role not in ("admin", "developer") and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user


async def require_developer(current_user: User = Depends(get_current_user)) -> User:
    """FastAPI dependency ensuring current user has developer role (unrestricted access)."""
    if current_user.role != "developer":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Developer access required",
        )
    return current_user
