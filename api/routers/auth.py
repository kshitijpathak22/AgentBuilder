"""
Authentication Router — Email-based Login, Token Refresh, and User Management.
Validates users against the allowed_users.json file stored in the api folder.
Provides RBAC management for user, admin, and developer roles.
"""
import os
import re
import uuid
from typing import Optional, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr

from api.core.auth import (
    authenticate_by_email,
    create_access_token,
    create_refresh_token,
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    User,
    LoginRequest,
    Token,
    get_all_allowed_users,
    get_current_user,
    get_user_role,
    require_admin,
    require_developer,
    update_user_role,
    add_allowed_user,
    remove_allowed_user,
    set_user_photo,
    get_user_photo,
    photo_url,
    VALID_ROLES,
    SECRET_KEY,
    ALGORITHM,
)
from api.core.config import USER_PHOTOS_DIR
from shared_logger import get_logger

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger(__name__)


class RefreshRequest(BaseModel):
    refresh_token: str


class MessageResponse(BaseModel):
    status: str
    message: str


class UpdateRoleRequest(BaseModel):
    email: str
    role: str


class AllowedUserResponse(BaseModel):
    email: str
    full_name: str = ""
    role: str = "user"
    is_admin: bool = False
    photo_url: str = ""


class AddUserRequest(BaseModel):
    email: str
    full_name: str = ""
    role: str = "user"


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHOTO_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
PHOTO_MAX_BYTES = 2 * 1024 * 1024
PHOTO_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(png|jpg|webp)$")


def _looks_like_image(data: bytes, ext: str) -> bool:
    if ext == "png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == "jpg":
        return data.startswith(b"\xff\xd8\xff")
    return data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _check_can_manage(caller: User, target_role: str, new_role: Optional[str] = None) -> None:
    """Admins may not touch developer accounts or hand out the developer role."""
    if caller.role == "developer":
        return
    if target_role == "developer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins cannot modify accounts with the developer role.")
    if new_role == "developer":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only developers can assign the developer role. Admins may only assign 'admin' or 'user'.",
        )


# ── Login ──────────────────────────────────────────────────────

@router.post("/login", response_model=Token)
async def login(login_data: LoginRequest):
    """
    Authenticate with email address and receive access + refresh tokens.
    The email must be present in the allowed_users.json file.
    """
    user = authenticate_by_email(login_data.email)
    if not user:
        logger.warning("Failed login attempt for email: %s", login_data.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This email is not authorized to access the system.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token = create_access_token(data={
        "sub": user.email,
        "role": user.role,
        "is_admin": user.is_admin,
    })
    refresh_token = create_refresh_token(data={
        "sub": user.email,
        "role": user.role,
        "is_admin": user.is_admin,
    })

    logger.info("Successful login for email: %s (role: %s)", user.email, user.role)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "role": user.role,
        "is_admin": user.is_admin,
        "full_name": user.full_name,
    }


# ── Token Refresh ──────────────────────────────────────────────

@router.post("/refresh", response_model=Token)
async def refresh_token(request: RefreshRequest):
    """Exchange a valid refresh token for a new access + refresh token pair."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate refresh token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(request.refresh_token, SECRET_KEY, algorithms=[ALGORITHM])
        email: Optional[str] = payload.get("sub")
        token_type: Optional[str] = payload.get("type")
        if email is None or token_type != "refresh":
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Re-validate against allowed users list
    user = authenticate_by_email(email)
    if user is None:
        raise credentials_exception

    new_access = create_access_token(data={
        "sub": email,
        "role": user.role,
        "is_admin": user.is_admin,
    })
    new_refresh = create_refresh_token(data={
        "sub": email,
        "role": user.role,
        "is_admin": user.is_admin,
    })

    logger.info("Token refreshed for email: %s (role: %s)", email, user.role)
    return {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "role": user.role,
        "is_admin": user.is_admin,
        "full_name": user.full_name,
    }


# ── User listing & role management (admin only) ────────────────

@router.get("/users", response_model=List[AllowedUserResponse])
async def list_users(admin: User = Depends(require_admin)):
    """
    List all allowed users from allowed_users.json. Admin access only.
    """
    logger.info("User list requested by: %s", admin.email)
    return get_all_allowed_users()


@router.put("/users/role", response_model=MessageResponse)
async def change_user_role(
    request: UpdateRoleRequest,
    caller: User = Depends(require_admin),
):
    """
    Update an allowed user's role.
    Developer can assign developer, admin, or user to anyone.
    Admin can only assign admin or user, and cannot modify developer accounts.
    """
    role = request.role.strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role '{role}'. Allowed roles: {list(VALID_ROLES)}",
        )

    # Admins have restricted role assignment capabilities
    if caller.role != "developer":
        current_target_role = get_user_role(request.email)
        if current_target_role == "developer":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admins cannot modify accounts with the developer role.",
            )
        if role == "developer":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only developers can assign the developer role. Admins may only assign 'admin' or 'user'.",
            )

    success = update_user_role(request.email, role)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User '{request.email}' not found or update failed.",
        )
    logger.info("User %s (role=%s) updated role for %s to %s", caller.email, caller.role, request.email, role)
    return MessageResponse(
        status="success",
        message=f"User role updated to '{role}' successfully.",
    )


# ── Current user info ──────────────────────────────────────────

@router.get("/me", response_model=AllowedUserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    """
    Return the currently authenticated user's information.
    """
    return AllowedUserResponse(
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        is_admin=current_user.is_admin,
        photo_url=photo_url(get_user_photo(current_user.email)),
    )


# ── Adding users & profile pictures (admin only) ───────────────

@router.post("/users", response_model=AllowedUserResponse, status_code=status.HTTP_201_CREATED)
async def add_user(request: AddUserRequest, caller: User = Depends(require_admin)):
    """Add an allowed user with a role. Admin access only."""
    email = request.email.strip().lower()
    role = request.role.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a valid email address.")
    if role not in VALID_ROLES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid role '{role}'. Allowed roles: {list(VALID_ROLES)}")
    _check_can_manage(caller, "user", role)
    if any(u["email"] == email for u in get_all_allowed_users()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A user with this email already exists.")
    if not add_allowed_user(email, request.full_name, role):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not save the new user.")
    logger.info("User %s (role=%s) added user %s with role %s", caller.email, caller.role, email, role)
    return AllowedUserResponse(email=email, full_name=request.full_name.strip(), role=role, is_admin=role in ("admin", "developer"))


@router.delete("/users", response_model=MessageResponse)
async def remove_user(email: str, caller: User = Depends(require_admin)):
    """Remove a user's access. Their past sessions stay in the database. Admin access only."""
    email = email.strip().lower()
    record = next((u for u in get_all_allowed_users() if u["email"] == email), None)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    if email == caller.email.strip().lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot remove your own account.")
    _check_can_manage(caller, record["role"])
    if record["role"] in ("admin", "developer") and sum(u["role"] in ("admin", "developer") for u in get_all_allowed_users()) <= 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot remove the last admin.")
    photo = get_user_photo(email)
    if not remove_allowed_user(email):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not remove the user.")
    if photo and PHOTO_NAME_RE.match(photo):
        try:
            os.remove(os.path.join(USER_PHOTOS_DIR, photo))
        except OSError:
            pass
    logger.info("User %s (role=%s) removed user %s", caller.email, caller.role, email)
    return MessageResponse(status="success", message=f"Removed {email}.")


@router.post("/users/photo", response_model=AllowedUserResponse)
async def upload_user_photo(
    email: str = Form(...),
    file: UploadFile = File(...),
    caller: User = Depends(require_admin),
):
    """Upload or replace a user's profile picture (PNG, JPEG or WebP, up to 2 MB). Admin access only."""
    email = email.strip().lower()
    record = next((u for u in get_all_allowed_users() if u["email"] == email), None)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    _check_can_manage(caller, record["role"])
    ext = PHOTO_TYPES.get((file.content_type or "").lower())
    data = await file.read(PHOTO_MAX_BYTES + 1)
    if not ext or not _looks_like_image(data, ext):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Upload a PNG, JPEG or WebP image.")
    if len(data) > PHOTO_MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The picture must be 2 MB or smaller.")

    os.makedirs(USER_PHOTOS_DIR, exist_ok=True)
    name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(USER_PHOTOS_DIR, name), "wb") as f:
        f.write(data)
    old = get_user_photo(email)
    if not set_user_photo(email, name):
        os.remove(os.path.join(USER_PHOTOS_DIR, name))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not save the picture.")
    if old and PHOTO_NAME_RE.match(old):
        try:
            os.remove(os.path.join(USER_PHOTOS_DIR, old))
        except OSError:
            pass
    logger.info("User %s updated the profile picture of %s", caller.email, email)
    return AllowedUserResponse(email=email, full_name=record["full_name"], role=record["role"],
                               is_admin=record["is_admin"], photo_url=photo_url(name))


@router.get("/photos/{filename}", include_in_schema=False)
async def get_user_photo_file(filename: str):
    """Serve a profile picture. Names are random, so <img> tags can load them without a token."""
    path = os.path.join(USER_PHOTOS_DIR, filename)
    if not PHOTO_NAME_RE.match(filename) or not os.path.isfile(path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


# ── Developer Diagnostics ──────────────────────────────────────

@router.get("/developer/diagnostics")
async def get_developer_diagnostics(developer: User = Depends(require_developer)):
    """
    Developer-only diagnostics endpoint returning runtime info.
    """
    from api.realtime.stats import GLOBAL_STATS
    from api.core.config import LLM_MODEL, NOVA_VOICE_ID, WS_BEARER_TOKEN
    return {
        "developer": developer.email,
        "role": developer.role,
        "config": {
            "llm_model": LLM_MODEL,
            "nova_voice_id": NOVA_VOICE_ID,
            "ws_token_configured": bool(WS_BEARER_TOKEN),
        },
        "global_stats": {
            "sessions_started": getattr(GLOBAL_STATS, "sessions_started", getattr(GLOBAL_STATS, "total_sessions", 0)),
            "sessions_ended": getattr(GLOBAL_STATS, "sessions_ended", 0),
            "total_audio_bytes_in": getattr(GLOBAL_STATS, "total_audio_bytes_in", getattr(GLOBAL_STATS, "audio_in_bytes", 0)),
            "total_audio_bytes_out": getattr(GLOBAL_STATS, "total_audio_bytes_out", getattr(GLOBAL_STATS, "audio_out_bytes", 0)),
        },
    }
