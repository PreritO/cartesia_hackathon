"""Vision Agents entry point for the AI Sports Commentator."""

import logging
from pathlib import Path

from vision_agents.core import Agent, AgentLauncher, Runner, User
from vision_agents.plugins.anthropic import LLM as ClaudeLLM
from vision_agents.plugins.cartesia import TTS as CartesiaTTS
from vision_agents.plugins.getstream import Edge

from agent.cartesia_stt import CartesiaSTT
from agent.config import config
from agent.processors.sports_processor import SportsCommentaryProcessor

logger = logging.getLogger(__name__)

# Load commentary instructions from markdown file
_INSTRUCTIONS_PATH = Path(__file__).parent / "instructions" / "commentary.md"
INSTRUCTIONS = _INSTRUCTIONS_PATH.read_text()


def create_agent() -> Agent:
    """Factory function that creates a fully configured sports commentator agent."""
    return Agent(
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
        processors=[
            SportsCommentaryProcessor(
                roboflow_api_key=config.roboflow_api_key,
                model_id=config.roboflow_model_id,
                detection_fps=config.detection_fps,
                confidence_threshold=config.detection_confidence,
                commentary_cooldown=config.commentary_cooldown,
            ),
        ],
    )


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
