"""Vision Agents entry point for the AI Sports Commentator.

Uses event-driven architecture: LocalDetectionProcessor emits
DetectionCompletedEvent, and the agent subscribes to it for
ball-tracking and commentary generation.
"""

import logging
import random
import time
from pathlib import Path

from vision_agents.core import Agent, AgentLauncher, Runner, User
from vision_agents.plugins.anthropic import LLM as ClaudeLLM
from vision_agents.plugins.cartesia import TTS as CartesiaTTS
from vision_agents.plugins.getstream import Edge

from agent.cartesia_stt import CartesiaSTT
from agent.config import config
from agent.processors.detection_processor import LocalDetectionProcessor
from agent.processors.events import DetectionCompletedEvent

logger = logging.getLogger(__name__)

# Load commentary instructions from markdown file
_INSTRUCTIONS_PATH = Path(__file__).parent / "instructions" / "commentary.md"
INSTRUCTIONS = _INSTRUCTIONS_PATH.read_text()

# Commentary prompts for when the ball is detected (variety keeps it fresh)
COMMENTARY_PROMPTS = [
    "Describe the current action on the field based on the player positions.",
    "What's happening in the play right now? Call it like you see it.",
    "Break down the formation and what the offense is trying to do.",
    "The ball is in play — give us the play-by-play!",
    "Read the field and tell us what's developing.",
]


class Debouncer:
    """Simple time-based debouncer to prevent commentary spam."""

    def __init__(self, interval: float) -> None:
        self._interval = interval
        self._last_time = 0.0

    def __bool__(self) -> bool:
        """Return True if enough time has passed since the last trigger."""
        now = time.monotonic()
        if (now - self._last_time) >= self._interval:
            self._last_time = now
            return True
        return False


def create_agent() -> Agent:
    """Factory function that creates a fully configured sports commentator agent."""
    processor = LocalDetectionProcessor(
        model_id=config.rfdetr_model_id,
        conf_threshold=config.detection_confidence,
        fps=config.detection_fps,
        classes=["person", "sports ball"],
        annotate=True,
    )

    agent = Agent(
        edge=Edge(
            api_key=config.stream_api_key,
            api_secret=config.stream_api_secret,
        ),
        agent_user=User(
            id="sports-commentator",
            name="Danny",
        ),
        instructions=INSTRUCTIONS,
        llm=ClaudeLLM(
            model="claude-sonnet-4-5-20250929",
            api_key=config.anthropic_api_key or None,
        ),
        stt=CartesiaSTT(
            api_key=config.cartesia_api_key or None,
            model="ink-whisper",
            language="en",
            max_silence_duration_secs=1.5,
        ),
        tts=CartesiaTTS(
            api_key=config.cartesia_api_key or None,
            model_id="sonic-3",
            voice_id=config.voice_id_danny or None,
            sample_rate=16000,
        ),
        processors=[processor],
    )

    # ---- Event-driven commentary ----

    debouncer = Debouncer(config.commentary_cooldown)

    # Ball tracking state
    ball_was_present = False
    consecutive_no_ball = 0
    NO_BALL_THRESHOLD = 3  # frames without ball before triggering

    @agent.events.subscribe
    async def on_detection(event: DetectionCompletedEvent) -> None:
        nonlocal ball_was_present, consecutive_no_ball

        ball_detected = any(obj["label"] == "sports ball" for obj in event.objects)

        # Ball reappearance after disappearing = play result
        if ball_detected and consecutive_no_ball >= NO_BALL_THRESHOLD:
            consecutive_no_ball = 0
            ball_was_present = True
            if debouncer:
                logger.info(
                    "Ball reappeared after disappearing — triggering play result commentary"
                )
                await agent.simple_response(
                    "The ball just reappeared after being out of frame! "
                    "Describe what likely happened — a completed pass, a big run, or a turnover."
                )
            return

        if ball_detected:
            consecutive_no_ball = 0
            ball_was_present = True
            if debouncer:
                await agent.simple_response(random.choice(COMMENTARY_PROMPTS))
        else:
            consecutive_no_ball += 1
            if consecutive_no_ball >= NO_BALL_THRESHOLD and ball_was_present and debouncer:
                logger.info(
                    "Ball disappeared for %d frames — triggering big play commentary",
                    consecutive_no_ball,
                )
                await agent.simple_response(
                    "Big play! The ball just disappeared from the camera's view — "
                    "that means a long pass, a breakaway run, or something dramatic is unfolding. "
                    "Build the excitement!"
                )

    return agent


async def join_call(agent: Agent, call_type: str, call_id: str) -> None:
    """Join a Stream Video call and run until the call ends."""
    call = await agent.edge.create_call(call_id, call_type=call_type)
    async with agent.join(call):
        await agent.finish()


launcher = AgentLauncher(
    create_agent=create_agent,
    join_call=join_call,
    agent_idle_timeout=120.0,
    max_concurrent_sessions=1,
    max_sessions_per_call=1,
)

runner = Runner(launcher=launcher)

if __name__ == "__main__":
    runner.cli()
