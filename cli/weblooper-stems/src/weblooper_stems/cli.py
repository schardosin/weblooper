"""CLI entry: weblooper-stems run <payload|job.json>"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from weblooper_stems import __version__
from weblooper_stems.drive import DriveError, patch_meta, upload_or_replace
from weblooper_stems.pipeline import DEFAULT_MODEL, STEM_NAMES, detect_device, run_pipeline


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def load_job(arg: str) -> dict[str, Any]:
    """Load job from JSON file path or base64url payload string."""
    cleaned = arg.strip().strip("'\"")

    # Prefer file path only when it looks like one (avoid OSError on long base64 args)
    looks_like_path = (
        cleaned.endswith(".json")
        or cleaned.startswith("/")
        or cleaned.startswith("./")
        or cleaned.startswith("../")
        or cleaned.startswith("~")
        or "/" in cleaned
    )
    if looks_like_path and len(cleaned) < 4096:
        path = Path(cleaned).expanduser()
        try:
            is_file = path.is_file()
        except OSError:
            is_file = False
        if is_file:
            with path.open("r", encoding="utf-8") as f:
                job = json.load(f)
            print(f"Loaded job file: {path}")
            return job

    # Treat as base64url-encoded JSON payload
    try:
        raw = _b64url_decode(cleaned)
        job = json.loads(raw.decode("utf-8"))
        print("Loaded job from command payload")
        return job
    except Exception as exc:
        raise SystemExit(
            f"Could not parse job argument as file or base64 payload.\n"
            f"Details: {exc}\n"
            f"Get a fresh command from weblooper (Separate Stems → On this computer)."
        ) from exc


def validate_job(job: dict[str, Any]) -> None:
    required = ["folderId", "youtubeUrl", "accessToken"]
    missing = [k for k in required if not job.get(k)]
    if missing:
        raise SystemExit(f"Job payload missing required fields: {', '.join(missing)}")

    expires = job.get("tokenExpiresAt")
    if expires is not None:
        try:
            exp_ms = int(expires)
        except (TypeError, ValueError):
            exp_ms = 0
        if exp_ms and time.time() * 1000 > exp_ms:
            raise SystemExit(
                "Google access token has expired.\n"
                "Go back to weblooper, open Separate Stems → On this computer, "
                "and copy a fresh command."
            )


def cmd_run(job_arg: str) -> int:
    job = load_job(job_arg)
    validate_job(job)

    folder_id = job["folderId"]
    youtube_url = job["youtubeUrl"]
    token = job["accessToken"]
    model = job.get("model") or DEFAULT_MODEL
    session_id = job.get("sessionId") or "?"
    title_hint = job.get("title") or ""

    print("=" * 50)
    print(f"weblooper-stems v{__version__}")
    print(f"Session:  {session_id}")
    print(f"Folder:   {folder_id}")
    print(f"YouTube:  {youtube_url}")
    if title_hint:
        print(f"Title:    {title_hint}")
    print(f"Model:    {model}")
    print(f"Device:   {detect_device()}")
    print("=" * 50)

    def report(stage: str, progress: float) -> None:
        try:
            patch_meta(
                token,
                folder_id,
                {
                    "status": "processing",
                    "stage": stage,
                    "progress": progress,
                    "source": "local-cli",
                    "model": f"local-{model}",
                },
            )
        except DriveError as e:
            if e.status == 401:
                raise
            print(f"  (warning: could not patch meta progress: {e})")

    try:
        report("starting", 0.0)

        encoded, title, duration = run_pipeline(
            youtube_url,
            model=model,
            on_stage=lambda s, p: report(s, p),
        )

        report("upload", 0.9)
        print("\nUploading stems to Google Drive…")
        uploaded: list[str] = []
        for stem_name in STEM_NAMES:
            path = encoded.get(stem_name)
            if not path:
                continue
            print(f"  Uploading {stem_name}.webm…", end=" ", flush=True)
            upload_or_replace(token, folder_id, f"{stem_name}.webm", path, "audio/webm")
            uploaded.append(stem_name)
            print("OK")

        if not uploaded:
            raise RuntimeError("No stems uploaded")

        processed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        patch_meta(
            token,
            folder_id,
            {
                "status": "ready",
                "stage": "done",
                "progress": 1.0,
                "stemNames": uploaded,
                "model": f"local-{model}",
                "source": "local-cli",
                "processedAt": processed_at,
                "duration": duration,
                "youtubeVideoTitle": title or title_hint or None,
            },
        )

        print()
        print("=" * 50)
        print("SUCCESS")
        print("=" * 50)
        print(f"{len(uploaded)} stems uploaded to Drive.")
        print(f"processedAt: {processed_at}")
        print()
        print("Go back to weblooper — it should detect the stems automatically.")
        return 0

    except DriveError as e:
        print(f"\nDrive error: {e}", file=sys.stderr)
        if e.status == 401:
            print(
                "Token expired or revoked. Copy a fresh command from weblooper.",
                file=sys.stderr,
            )
        try:
            patch_meta(
                token,
                folder_id,
                {"status": "error", "stage": "error", "error": str(e), "source": "local-cli"},
            )
        except Exception:
            pass
        return 1
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        traceback.print_exc()
        try:
            patch_meta(
                token,
                folder_id,
                {
                    "status": "error",
                    "stage": "error",
                    "error": str(e)[:500],
                    "source": "local-cli",
                },
            )
        except Exception:
            pass
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="weblooper-stems",
        description="Local stem separation for weblooper (yt-dlp + Demucs → Google Drive)",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="Run a job from base64 payload or JSON file")
    run_p.add_argument(
        "job",
        help="Base64url job payload from weblooper, or path to weblooper-job-*.json",
    )

    args = parser.parse_args(argv)

    if args.command == "run":
        return cmd_run(args.job)

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
