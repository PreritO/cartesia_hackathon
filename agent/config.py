"""Environment configuration for the AI Sports Commentator agent."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    """Application configuration loaded from environment variables."""

    # Stream
    stream_api_key: str = os.getenv("STREAM_API_KEY", "")
    stream_api_secret: str = os.getenv("STREAM_API_SECRET", "")

    # LLM
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    google_api_key: str = os.getenv("GOOGLE_API_KEY", "")

    # Cartesia TTS
    cartesia_api_key: str = os.getenv("CARTESIA_API_KEY", "")

    # Deepgram STT
    deepgram_api_key: str = os.getenv("DEEPGRAM_API_KEY", "")

    # Roboflow
    roboflow_api_key: str = os.getenv("ROBOFLOW_API_KEY", "")

    # Voice IDs
    voice_id_danny: str = os.getenv("VOICE_ID_DANNY", "")
    voice_id_coach_kay: str = os.getenv("VOICE_ID_COACH_KAY", "")
    voice_id_rookie: str = os.getenv("VOICE_ID_ROOKIE", "")

    # Detection settings
    detection_fps: int = 5
    detection_confidence: float = 0.5
    commentary_cooldown: float = 3.0


config = Config()
