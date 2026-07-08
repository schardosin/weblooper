"""Download → Demucs → Opus/WebM encode pipeline."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
from pathlib import Path

STEM_NAMES = ["drums", "bass", "guitar", "piano", "vocals", "other"]
DEFAULT_MODEL = "htdemucs_6s"


def detect_device() -> str:
    """Return a human label for the best available compute device."""
    try:
        import torch

        if torch.cuda.is_available():
            return f"cuda ({torch.cuda.get_device_name(0)})"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps (Apple Silicon)"
    except Exception:
        pass
    return "cpu"


def torch_device() -> str:
    """Return torch device string: cuda | mps | cpu."""
    label = detect_device()
    if label.startswith("cuda"):
        return "cuda"
    if label.startswith("mps"):
        return "mps"
    return "cpu"


def get_ffmpeg_exe() -> str:
    """Prefer system ffmpeg; fall back to imageio-ffmpeg bundled binary."""
    which = shutil.which("ffmpeg")
    if which:
        return which
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        raise RuntimeError(
            "ffmpeg not found. Install ffmpeg or rely on imageio-ffmpeg "
            f"(bundled with this package). Details: {exc}"
        ) from exc


def download_youtube_audio(youtube_url: str, out_dir: Path) -> tuple[Path, str, float]:
    """
    Download best audio as WAV via yt-dlp.
    Returns (wav_path, title, duration_sec).
    """
    import yt_dlp

    out_dir.mkdir(parents=True, exist_ok=True)
    # yt-dlp will write audio.<ext> then extract to audio.wav
    outtmpl = str(out_dir / "audio.%(ext)s")
    wav_path = out_dir / "audio.wav"
    if wav_path.exists():
        wav_path.unlink()

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
                "preferredquality": "0",
            }
        ],
        "quiet": False,
        "no_warnings": True,
        # Help ffmpeg discovery when using bundled binary
        "ffmpeg_location": str(Path(get_ffmpeg_exe()).parent),
    }

    print(f"Downloading audio from: {youtube_url}")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=True)
        title = (info or {}).get("title") or "Unknown"
        duration = float((info or {}).get("duration") or 0)

    if not wav_path.exists():
        # Some yt-dlp versions may leave a different name
        candidates = list(out_dir.glob("audio.*"))
        raise FileNotFoundError(
            f"Download failed — expected {wav_path}. Found: {[c.name for c in candidates]}"
        )

    size_mb = wav_path.stat().st_size / (1024 * 1024)
    print(f"Title: {title}")
    print(f"Duration: {duration:.0f}s")
    print(f"Audio file: {size_mb:.1f} MB")
    return wav_path, title, duration


def separate_stems(audio_path: Path, out_dir: Path, model: str = DEFAULT_MODEL) -> Path:
    """
    Run Demucs (htdemucs_6s by default) and write stem WAVs with soundfile.

    Avoids demucs.separate.main → torchaudio.save, which requires TorchCodec on
    torchaudio 2.9+ and fails when torchcodec is missing.
    """
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.pretrained import get_model

    if out_dir.exists():
        shutil.rmtree(out_dir)

    stem_dir = out_dir / model / audio_path.stem
    stem_dir.mkdir(parents=True, exist_ok=True)

    device = torch_device()
    device_label = detect_device()
    print(f"Running {model} stem separation on {device_label}…")
    print("(First run may download model weights.)")
    print("Saving stems via soundfile (no torchcodec required).")
    print()

    net = get_model(model)
    net.eval()

    # Load mix with soundfile only (never torchaudio.load/save)
    data, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
    # data: [T, C] → torch [C, T]
    wav = torch.from_numpy(np.ascontiguousarray(data.T))

    target_sr = getattr(net, "samplerate", 44100)
    target_ch = getattr(net, "audio_channels", 2)
    wav = convert_audio(wav, sr, target_sr, target_ch)

    # Match demucs.separate normalization for stable levels
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)

    t0 = time.time()
    with torch.no_grad():
        sources = apply_model(
            net,
            wav[None],
            device=device,
            progress=True,
            num_workers=0,
        )[0]
    sources = sources * (ref.std() + 1e-8) + ref.mean()
    elapsed = time.time() - t0
    print(f"\nSeparation complete in {elapsed:.1f}s")

    # sources: [S, C, T]
    source_names = list(getattr(net, "sources", STEM_NAMES))
    for i, name in enumerate(source_names):
        stem = sources[i].detach().cpu().numpy()  # [C, T]
        out = np.ascontiguousarray(stem.T)  # [T, C] for soundfile
        # Clip lightly to valid float range
        out = np.clip(out, -1.0, 1.0)
        out_path = stem_dir / f"{name}.wav"
        sf.write(str(out_path), out, target_sr, subtype="FLOAT")
        size_mb = out_path.stat().st_size / (1024 * 1024)
        print(f"  {name}.wav: {size_mb:.1f} MB")

    found = [p.name for p in stem_dir.glob("*.wav")]
    print(f"Stems written to {stem_dir}: {found}")

    # Warn if expected 6-stem names missing
    for name in STEM_NAMES:
        if not (stem_dir / f"{name}.wav").exists():
            print(f"  WARNING: {name}.wav not found")

    return stem_dir


def encode_stems_to_webm(stem_dir: Path, webm_dir: Path) -> dict[str, Path]:
    """Encode each stem WAV to Opus in WebM at 128 kbps."""
    ffmpeg = get_ffmpeg_exe()
    webm_dir.mkdir(parents=True, exist_ok=True)
    encoded: dict[str, Path] = {}

    print("Encoding stems to Opus/WebM (128 kbps)…")
    for stem_name in STEM_NAMES:
        wav_path = stem_dir / f"{stem_name}.wav"
        if not wav_path.exists():
            print(f"  Skipping {stem_name} (not found)")
            continue
        webm_path = webm_dir / f"{stem_name}.webm"
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            str(wav_path),
            "-c:a",
            "libopus",
            "-b:a",
            "128k",
            "-vn",
            str(webm_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  ERROR encoding {stem_name}: {(result.stderr or '')[-300:]}")
            continue
        print(f"  {stem_name}.webm: {webm_path.stat().st_size / (1024 * 1024):.1f} MB")
        encoded[stem_name] = webm_path

    print(f"Encoded {len(encoded)}/{len(STEM_NAMES)} stems.")
    return encoded


def run_pipeline(
    youtube_url: str,
    work_dir: Path | None = None,
    model: str = DEFAULT_MODEL,
    on_stage=None,
) -> tuple[dict[str, Path], str, float]:
    """
    Full local pipeline. Returns (encoded_webm_paths, title, duration).
    on_stage(stage: str, progress: float) optional callback.
    """

    def stage(name: str, progress: float) -> None:
        if on_stage:
            on_stage(name, progress)
        print(f"\n=== stage: {name} ({progress:.0%}) ===")

    if work_dir is None:
        work_dir = Path(tempfile.mkdtemp(prefix="weblooper-stems-"))

    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    stage("download", 0.05)
    wav_path, title, duration = download_youtube_audio(youtube_url, work_dir / "download")

    stage("separate", 0.25)
    stem_dir = separate_stems(wav_path, work_dir / "stems", model=model)

    stage("encode", 0.75)
    encoded = encode_stems_to_webm(stem_dir, work_dir / "webm")

    if not encoded:
        raise RuntimeError("No stems were encoded — cannot continue.")

    stage("encode_done", 0.85)
    return encoded, title, duration
