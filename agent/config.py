"""Environment configuration for the AI Sports Commentator agent."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    """Application configuration loaded from environment variables."""

    # LLM (Claude direct)
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")

    # Cartesia (TTS + STT)
    cartesia_api_key: str = os.getenv("CARTESIA_API_KEY", "")

    # RF-DETR (local model, no API key needed)
    rfdetr_model_id: str = os.getenv("RFDETR_MODEL_ID", "rfdetr-base")

    # Voice IDs
    voice_id_danny: str = os.getenv("VOICE_ID_DANNY", "")
    voice_id_coach_kay: str = os.getenv("VOICE_ID_COACH_KAY", "")
    voice_id_rookie: str = os.getenv("VOICE_ID_ROOKIE", "")

    # Detection settings
    detection_fps: int = 5
    detection_confidence: float = 0.5
    commentary_cooldown: float = 5.0

    # Server settings
    server_port: int = int(os.getenv("SERVER_PORT", "8000"))
    videos_dir: str = os.getenv("VIDEOS_DIR", "./videos")
    max_video_duration: int = int(os.getenv("MAX_VIDEO_DURATION", "700"))


config = Config()
