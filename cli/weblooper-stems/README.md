# weblooper-stems

Local CLI for [weblooper](https://schardosin.github.io/weblooper/) stem separation.

Runs on **your computer**: downloads YouTube audio with `yt-dlp`, separates 6 stems with Meta **HTDemucs** (`htdemucs_6s`), encodes Opus/WebM, and updates the Drive session created by the website.

## Quick start (from the website)

1. Sign in to Google Drive on weblooper.
2. Load a YouTube video → **Separate Stems** → **On this computer**.
3. Install [uv](https://github.com/astral-sh/uv) once (if needed):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

4. Paste the command the site gives you (or run a downloaded job file):

```bash
uvx weblooper-stems@0.1.2 run '<payload-from-site>'
# or
uvx weblooper-stems@0.1.2 run ~/Downloads/weblooper-job-….json
```



5. Leave the weblooper tab open — it polls Drive and loads stems automatically.

## Auth model

The **website** is the SSO. The job payload includes a short-lived Google access token (`drive.file` scope) so this CLI can update the placeholder stem files the site created. No second Google login in the terminal.

If the token expired, go back to weblooper and copy a fresh command.

## Requirements

- Python 3.10+ (provided by `uvx` automatically)
- Disk space for PyTorch + Demucs models (first run downloads a lot)
- Optional: NVIDIA CUDA or Apple Silicon MPS for much faster separation
- Network access to YouTube, Google Drive, and model hosts

## Dev install

```bash
cd cli/weblooper-stems
uv sync
uv run weblooper-stems run path/to/job.json
```

## License

MIT
