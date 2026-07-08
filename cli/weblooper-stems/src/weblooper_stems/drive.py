"""Minimal Google Drive v3 helpers using a user access token (no extra OAuth)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import requests

DRIVE_API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"


class DriveError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body


def _headers(token: str, content_type: str | None = None) -> dict[str, str]:
    h = {"Authorization": f"Bearer {token}"}
    if content_type:
        h["Content-Type"] = content_type
    return h


def list_files_in_folder(token: str, folder_id: str, name: str | None = None) -> list[dict[str, Any]]:
    q = f"'{folder_id}' in parents and trashed = false"
    if name:
        # Escape single quotes in name for Drive query language
        safe = name.replace("'", "\\'")
        q += f" and name = '{safe}'"
    params = {
        "q": q,
        "fields": "files(id,name,mimeType,size)",
        "pageSize": "100",
    }
    res = requests.get(f"{DRIVE_API}/files", headers=_headers(token), params=params, timeout=60)
    if res.status_code == 401:
        raise DriveError(
            "Google access token rejected (401). Go back to weblooper and copy a fresh command.",
            status=401,
            body=res.text[:300],
        )
    if not res.ok:
        raise DriveError(f"Drive list failed: {res.status_code}", status=res.status_code, body=res.text[:300])
    return res.json().get("files") or []


def download_text(token: str, file_id: str) -> str:
    res = requests.get(
        f"{DRIVE_API}/files/{file_id}",
        headers=_headers(token),
        params={"alt": "media"},
        timeout=120,
    )
    if res.status_code == 401:
        raise DriveError(
            "Google access token rejected (401). Go back to weblooper and copy a fresh command.",
            status=401,
        )
    if not res.ok:
        raise DriveError(f"Drive download failed: {res.status_code}", status=res.status_code)
    return res.text


def update_file_media(token: str, file_id: str, data: bytes, mime_type: str) -> None:
    res = requests.patch(
        f"{UPLOAD_API}/files/{file_id}",
        headers=_headers(token, mime_type),
        params={"uploadType": "media"},
        data=data,
        timeout=600,
    )
    if res.status_code == 401:
        raise DriveError(
            "Google access token rejected (401) during upload. "
            "Token may have expired mid-job — copy a fresh command from weblooper.",
            status=401,
        )
    if not res.ok:
        raise DriveError(
            f"Drive update failed: {res.status_code}",
            status=res.status_code,
            body=res.text[:400],
        )


def create_file(token: str, folder_id: str, name: str, data: bytes, mime_type: str) -> str:
    """Fallback create if placeholder is missing (prefer update)."""
    metadata = {"name": name, "parents": [folder_id]}
    boundary = "weblooper_boundary"
    meta_json = json.dumps(metadata)
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{meta_json}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n"
        f"Content-Transfer-Encoding: binary\r\n\r\n"
    ).encode("utf-8") + data + f"\r\n--{boundary}--".encode("utf-8")

    res = requests.post(
        f"{UPLOAD_API}/files",
        headers=_headers(token, f"multipart/related; boundary={boundary}"),
        params={"uploadType": "multipart"},
        data=body,
        timeout=600,
    )
    if not res.ok:
        raise DriveError(f"Drive create failed: {res.status_code}", status=res.status_code, body=res.text[:400])
    return res.json()["id"]


def upload_or_replace(token: str, folder_id: str, filename: str, path: Path, mime_type: str) -> str:
    """Update existing placeholder (required for drive.file ownership) or create."""
    data = path.read_bytes()
    existing = list_files_in_folder(token, folder_id, filename)
    if existing:
        file_id = existing[0]["id"]
        update_file_media(token, file_id, data, mime_type)
        return file_id
    return create_file(token, folder_id, filename, data, mime_type)


def patch_meta(
    token: str,
    folder_id: str,
    updates: dict[str, Any],
) -> dict[str, Any]:
    """Merge updates into meta.json in the session folder."""
    files = list_files_in_folder(token, folder_id, "meta.json")
    current: dict[str, Any] = {}
    meta_id: str | None = None
    if files:
        meta_id = files[0]["id"]
        try:
            current = json.loads(download_text(token, meta_id))
        except Exception:
            current = {}

    current.update(updates)
    payload = json.dumps(current, indent=2).encode("utf-8")

    if meta_id:
        update_file_media(token, meta_id, payload, "application/json")
    else:
        create_file(token, folder_id, "meta.json", payload, "application/json")

    return current
