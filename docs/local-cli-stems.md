# Local CLI stem separation

## Overview

**On this computer** lets users run high-quality 6-stem separation on their own machine while the website stays a static GitHub Pages app.

```
weblooper (SSO + Drive session + poll)
        │  copy: uvx weblooper-stems run <job>
        ▼
weblooper-stems CLI (user machine)
  yt-dlp → Demucs htdemucs_6s → Opus/WebM → Drive update
        │
        ▼
weblooper detects meta.status=ready → OPFS + practice UI
```

## Host requirements (self-contained)

| Needed on the machine | Notes |
|----------------------|--------|
| **`uv` / `uvx` only** | Official installers for macOS, Linux, Windows |
| System Python / pip / conda | **Not required** — uv installs an isolated env |
| torch, demucs, ffmpeg on PATH | **Not required** — pulled into the uv cache; ffmpeg via `imageio-ffmpeg` |

First run needs **network + disk** (PyTorch wheel is large). Supported desktops: **macOS**, **Windows 10/11 x64**, **Linux x64**.

### Install uv

**macOS / Linux:**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```
Then open a **new** PowerShell window.

### Windows notes

- Use **PowerShell** (not `cmd.exe`) for the one-liner.
- GPU: **CPU by default**; CUDA needs a CUDA-enabled torch install (advanced).
- Current `git+https` install source needs **Git for Windows** on PATH until the package is published to PyPI.

### macOS notes

- Apple Silicon uses **MPS** when available.
- Leading space on the one-liner helps with `HISTCONTROL=ignorespace`.

## Why a short-lived token in the command?

The site uses Google `drive.file` scope and pre-creates empty stem placeholders so it can still **read** files after an external process fills them.

A separate CLI OAuth client cannot update those placeholders under `drive.file`. So the **website remains SSO**; the job payload is embedded in the one-liner (access token ~1 hour). The CLI never opens a second Google login.

Mitigations:

- Leading space on the command for `HISTCONTROL=ignorespace` (Unix)
- Short-lived token; clear expiry errors asking for a fresh command

## Package

| Item | Value |
|------|--------|
| Path | `cli/weblooper-stems/` |
| PyPI name | `weblooper-stems` (optional; site currently uses git `uvx --from`) |
| Site pin | `WEBLOOPER_STEMS_CLI_VERSION` + `WEBLOOPER_STEMS_UVX_FROM` in `src/stems/local-cli.ts` |
| Stems | drums, bass, guitar, piano, vocals, other |

## Publishing (maintainers)

```bash
cd cli/weblooper-stems
uv build
uv publish   # or twine, once credentials are set
```

Bump version in:

1. `cli/weblooper-stems/pyproject.toml`
2. `cli/weblooper-stems/src/weblooper_stems/__init__.py`
3. `src/stems/local-cli.ts` → `WEBLOOPER_STEMS_CLI_VERSION`

## Dev without PyPI

```bash
cd cli/weblooper-stems
uv sync
# Paste the site one-liner, or for local dev:
uvx --from ./cli/weblooper-stems weblooper-stems run '<payload-from-site>'
```

## Related code

- `src/stems/local-cli.ts` — payload + command formatting
- `src/drive/sync.ts` — `createExternalStemSession`, `checkExternalStemStatus`, `getExternalStemProgress`
- `src/main.ts` — method picker + waiting modal
- `public/notebooks/colab_stem_separator.ipynb` — same pipeline for Colab GPU
