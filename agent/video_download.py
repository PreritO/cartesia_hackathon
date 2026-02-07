"""YouTube video download utility using yt-dlp."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path

from yt_dlp import YoutubeDL

logger = logging.getLogger(__name__)


@dataclass
class VideoInfo:
    """Metadata about a downloaded video."""

    video_id: str
    title: str
    duration: int  # seconds
    path: Path


def _make_video_id(url: str) -> str:
    """Derive a short deterministic ID from the URL."""
    return hashlib.sha256(url.encode()).hexdigest()[:12]


async def download_video(
    url: str,
    output_dir: str = "./videos",
    max_duration: int = 600,
) -> VideoInfo:
    """Download a YouTube video to MP4 (720p max).

    Args:
        url: YouTube URL.
        output_dir: Directory to save the MP4 file.
        max_duration: Maximum allowed duration in seconds (default 10 min).

    Returns:
        VideoInfo with metadata and local file path.

    Raises:
        ValueError: If the video exceeds max_duration or URL is invalid.
        RuntimeError: If the download fails.
    """
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    video_id = _make_video_id(url)
    file_path = out_path / f"{video_id}.mp4"

    # If already downloaded, return cached info
    if file_path.exists():
        logger.info("Video already downloaded: %s", file_path)
        info = await _extract_info(url)
        return VideoInfo(
            video_id=video_id,
            title=info.get("title", "Unknown"),
            duration=info.get("duration", 0),
            path=file_path,
        )

    # Extract info first to check duration
    info = await _extract_info(url)
    duration = info.get("duration", 0)
    title = info.get("title", "Unknown")

    if duration > max_duration:
        raise ValueError(
            f"Video is {duration}s, exceeds max of {max_duration}s. Use a shorter clip."
        )

    logger.info("Downloading: %s (%ds) → %s", title, duration, file_path)

    # Download in a thread to avoid blocking the event loop
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _download, url, str(file_path))

    if not file_path.exists():
        raise RuntimeError(f"Download completed but file not found: {file_path}")

    logger.info("Download complete: %s (%.1f MB)", file_path, file_path.stat().st_size / 1e6)

    return VideoInfo(
        video_id=video_id,
        title=title,
        duration=duration,
        path=file_path,
    )


async def _extract_info(url: str) -> dict:
    """Extract video metadata without downloading."""
    loop = asyncio.get_running_loop()

    def _extract():
        with YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            return ydl.extract_info(url, download=False)

    return await loop.run_in_executor(None, _extract)


def _download(url: str, output_path: str) -> None:
    """Download the video to a specific path (blocking)."""
    opts = {
        "format": "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "outtmpl": output_path,
        "merge_output_format": "mp4",
        "quiet": False,
        "no_warnings": True,
    }
    with YoutubeDL(opts) as ydl:
        ydl.download([url])
