"""FastAPI server for the AI Sports Commentator.

Endpoints:
- POST /api/start           — Download a YouTube video and return session info
- POST /api/profile-chat    — Text-based profile onboarding (legacy)
- POST /api/agent-token     — Get a Cartesia access token for the voice agent
- POST /api/extract-profile — Extract structured profile from conversation transcript
- POST /api/call-transcript    — Fetch latest Cartesia call transcript + extract profile
- WS   /ws/{session_id}     — Stream commentary (text + TTS audio) over WebSocket
- GET  /api/health           — Health check
"""

from __future__ import annotations

import base64
import json as json_module
import logging
import re
import uuid
from pathlib import Path

from anthropic import AsyncAnthropic
from cartesia import AsyncCartesia
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agent.config import config
from agent.pipeline import CommentaryPipeline, LiveCommentaryPipeline, get_or_load_model
from agent.user_profile import PERSONAS, UserProfile
from agent.video_download import VideoInfo, download_video

logger = logging.getLogger(__name__)

app = FastAPI(title="AI Sports Commentator")

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store: session_id -> VideoInfo
_sessions: dict[str, VideoInfo] = {}

# Active pipelines for cleanup
_active_pipelines: dict[str, CommentaryPipeline] = {}


# ---- Models ----


class StartRequest(BaseModel):
    url: str


class StartResponse(BaseModel):
    session_id: str
    title: str
    duration: int
    video_url: str


# ---- Endpoints ----


@app.on_event("startup")
async def startup():
    """Pre-load the RF-DETR model on server start so first request is fast."""
    videos_dir = Path(config.videos_dir)
    videos_dir.mkdir(parents=True, exist_ok=True)

    # Mount videos directory for static serving
    app.mount("/videos", StaticFiles(directory=str(videos_dir)), name="videos")

    # Skip model warmup when detection is disabled (faster startup)
    if not config.skip_detection:
        logger.info("Starting RF-DETR model warmup...")
        await get_or_load_model()
        logger.info("RF-DETR model ready. Server is live.")
    else:
        logger.info("Detection skipped — frames go straight to Claude. Server is live.")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ---- Cartesia Voice Agent Token ----


@app.post("/api/agent-token")
async def agent_token():
    """Mint a short-lived Cartesia access token for the voice agent WebSocket."""
    import httpx

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.cartesia.ai/access-token",
            headers={
                "Content-Type": "application/json",
                "Cartesia-Version": "2025-04-16",
                "Authorization": f"Bearer {config.cartesia_api_key}",
            },
            json={"grants": {"agent": True}, "expires_in": 300},
        )
        resp.raise_for_status()
        return resp.json()


# ---- Profile Onboarding Chat ----

_PROFILE_SYSTEM_PROMPT = """\
You are Danny, the lead play-by-play commentator for our AI sports broadcast. \
Right now the game hasn't started yet -- you're doing a quick pre-game chat with \
a new viewer to learn about them so you can personalize the commentary.

Be warm, natural, and brief (1-2 sentences per response). You're a sports buddy, \
not a form. Weave questions in conversationally -- don't number them or make it \
feel like an interview checklist.

You need to find out:
1. The viewer's first name
2. Their favorite team (if any -- it's okay if they don't have one)
3. Their experience level with the sport (beginner, casual, knowledgeable, or expert)
4. Any favorite players they love watching
5. How they want the commentary style -- balanced/objective, a bit biased toward \
their team, or full homer mode

After you have gathered enough information (usually 4-5 exchanges), output your \
final message that wraps up the chat AND include a JSON block in exactly this format \
at the END of your message:

[PROFILE_COMPLETE]{"name": "...", "favorite_team": "...", "experience": "beginner|casual|knowledgeable|expert", "favorite_players": ["..."], "style": "balanced|moderate|homer"}[/PROFILE_COMPLETE]

If the viewer skips a question or says they don't have a preference, use sensible \
defaults (no team, casual experience, balanced style, empty players list). \
Do NOT output the [PROFILE_COMPLETE] block until you have asked enough questions.

Keep it short and fun -- you're excited for the game!\
"""

_EXPERIENCE_TO_EXPERTISE: dict[str, int] = {
    "beginner": 15,
    "casual": 40,
    "knowledgeable": 65,
    "expert": 90,
}

_STYLE_TO_HOT_TAKE: dict[str, int] = {
    "balanced": 25,
    "moderate": 50,
    "homer": 80,
}

_PROFILE_COMPLETE_RE = re.compile(
    r"\[PROFILE_COMPLETE\]\s*(\{.*?\})\s*\[/PROFILE_COMPLETE\]",
    re.DOTALL,
)


class ProfileChatRequest(BaseModel):
    messages: list[dict]  # [{"role": "user"|"assistant", "text": str}, ...]


class ProfileChatResponse(BaseModel):
    text: str
    audio: str | None = None
    done: bool = False
    profile: dict | None = None


@app.post("/api/profile-chat", response_model=ProfileChatResponse)
async def profile_chat(req: ProfileChatRequest):
    """Drive a conversational onboarding flow with Danny to build a UserProfile."""

    # Build Anthropic messages from the conversation history.
    anthropic_messages: list[dict] = []
    for msg in req.messages:
        role = msg.get("role", "user")
        text = msg.get("text", "")
        if role in ("user", "assistant") and text:
            anthropic_messages.append({"role": role, "content": text})

    # First call (empty history) — seed with a greeting trigger.
    if not anthropic_messages:
        anthropic_messages = [{"role": "user", "content": "Hey! I just tuned in."}]

    # Call Claude to generate Danny's next response.
    anthropic = AsyncAnthropic(api_key=config.anthropic_api_key)
    llm_response = await anthropic.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=300,
        system=_PROFILE_SYSTEM_PROMPT,
        messages=anthropic_messages,
    )

    raw_text: str = llm_response.content[0].text

    # Check if Danny decided the profile is complete.
    profile_match = _PROFILE_COMPLETE_RE.search(raw_text)
    done = profile_match is not None
    profile_dict: dict | None = None

    # The text the user sees/hears should not contain the raw JSON block.
    display_text = _PROFILE_COMPLETE_RE.sub("", raw_text).strip()

    if profile_match:
        try:
            extracted = json_module.loads(profile_match.group(1))
        except json_module.JSONDecodeError:
            extracted = {}

        experience_key = extracted.get("experience", "casual").lower()
        style_key = extracted.get("style", "balanced").lower()

        profile_dict = {
            "name": extracted.get("name", "Fan"),
            "favorite_team": extracted.get("favorite_team"),
            "expertise_slider": _EXPERIENCE_TO_EXPERTISE.get(experience_key, 40),
            "hot_take_slider": _STYLE_TO_HOT_TAKE.get(style_key, 25),
            "favorite_players": extracted.get("favorite_players", []),
            "voice_key": "danny",
        }

    # Synthesize Danny's response via Cartesia TTS.
    audio_b64: str | None = None
    if display_text and config.cartesia_api_key:
        try:
            cartesia = AsyncCartesia(api_key=config.cartesia_api_key)
            tts_response = cartesia.tts.bytes(
                model_id="sonic-3",
                transcript=display_text,
                voice={"mode": "id", "id": config.voice_id_danny},
                output_format={
                    "container": "mp3",
                    "sample_rate": 44100,
                    "bit_rate": 128000,
                },
                language="en",
                generation_config={"speed": 1.1},
            )
            audio_chunks: list[bytes] = []
            async for chunk in tts_response:
                audio_chunks.append(chunk)
            audio_bytes = b"".join(audio_chunks)
            audio_b64 = base64.b64encode(audio_bytes).decode()
            await cartesia.close()
        except Exception:
            logger.exception("Cartesia TTS failed during profile chat")

    return ProfileChatResponse(
        text=display_text,
        audio=audio_b64,
        done=done,
        profile=profile_dict,
    )


# ---- Profile Extraction (for Cartesia Voice Agent flow) ----

_EXTRACT_PROMPT = """\
Extract a viewer profile from this conversation transcript between a sports \
commentator (Danny) and a viewer. Return ONLY a JSON object with these fields:

{"name": "string", "favorite_team": "string or null", "experience": "beginner|casual|knowledgeable|expert", "favorite_players": ["string array"], "style": "balanced|moderate|homer"}

If any field wasn't mentioned, use defaults: name="Fan", favorite_team=null, \
experience="casual", favorite_players=[], style="balanced".

Return ONLY the JSON, no other text.\
"""


class ExtractProfileRequest(BaseModel):
    transcript: str


class ExtractProfileResponse(BaseModel):
    profile: dict


@app.post("/api/extract-profile", response_model=ExtractProfileResponse)
async def extract_profile(req: ExtractProfileRequest):
    """Extract a structured UserProfile from a voice conversation transcript."""
    anthropic = AsyncAnthropic(api_key=config.anthropic_api_key)
    llm_response = await anthropic.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=200,
        system=_EXTRACT_PROMPT,
        messages=[{"role": "user", "content": req.transcript}],
    )

    raw = llm_response.content[0].text.strip()

    # Parse the JSON from Claude's response
    try:
        extracted = json_module.loads(raw)
    except json_module.JSONDecodeError:
        # Try to find JSON within the response
        import re as _re

        match = _re.search(r"\{.*\}", raw, _re.DOTALL)
        extracted = json_module.loads(match.group(0)) if match else {}

    experience_key = extracted.get("experience", "casual").lower()
    style_key = extracted.get("style", "balanced").lower()

    profile_dict = {
        "name": extracted.get("name", "Fan"),
        "favorite_team": extracted.get("favorite_team"),
        "expertise_slider": _EXPERIENCE_TO_EXPERTISE.get(experience_key, 40),
        "hot_take_slider": _STYLE_TO_HOT_TAKE.get(style_key, 25),
        "favorite_players": extracted.get("favorite_players", []),
        "voice_key": "danny",
    }

    return ExtractProfileResponse(profile=profile_dict)


# ---- Cartesia Call Transcript (for post-call profile extraction) ----


class CallTranscriptResponse(BaseModel):
    transcript: str
    profile: dict


class CallTranscriptRequest(BaseModel):
    agent_id: str


@app.post("/api/call-transcript", response_model=CallTranscriptResponse)
async def call_transcript(req: CallTranscriptRequest):
    """Fetch transcript from the most recent Cartesia voice agent call and extract profile."""
    import httpx

    # 1. List recent calls for this agent (most recent first) with transcript expanded
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.cartesia.ai/agents/calls",
            headers={
                "Cartesia-Version": "2025-04-16",
                "Authorization": f"Bearer {config.cartesia_api_key}",
            },
            params={
                "agent_id": req.agent_id,
                "expand": "transcript",
                "limit": 1,
            },
        )
        resp.raise_for_status()
        result = resp.json()

    calls = result.get("data", [])
    if not calls:
        return CallTranscriptResponse(
            transcript="",
            profile={
                "name": "Fan",
                "favorite_team": None,
                "expertise_slider": 40,
                "hot_take_slider": 25,
                "favorite_players": [],
                "voice_key": "danny",
            },
        )

    call_data = calls[0]

    # 2. Build a readable transcript string from the call data
    transcript_parts: list[str] = []
    for turn in call_data.get("transcript", []):
        role = turn.get("role", "unknown")
        text = turn.get("text", "")
        speaker = "Danny" if role == "assistant" else "Viewer"
        transcript_parts.append(f"{speaker}: {text}")

    transcript_text = "\n".join(transcript_parts)
    logger.info(
        "Fetched transcript for call %s: %d turns",
        call_data.get("id", "?"),
        len(transcript_parts),
    )
    logger.info("Transcript text:\n%s", transcript_text)

    # 3. Extract structured profile via Claude
    anthropic = AsyncAnthropic(api_key=config.anthropic_api_key)
    llm_response = await anthropic.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=200,
        system=_EXTRACT_PROMPT,
        messages=[{"role": "user", "content": transcript_text}],
    )

    raw = llm_response.content[0].text.strip()

    try:
        extracted = json_module.loads(raw)
    except json_module.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        extracted = json_module.loads(match.group(0)) if match else {}

    experience_key = extracted.get("experience", "casual").lower()
    style_key = extracted.get("style", "balanced").lower()

    profile_dict = {
        "name": extracted.get("name", "Fan"),
        "favorite_team": extracted.get("favorite_team"),
        "experience": experience_key,
        "style": style_key,
        "expertise_slider": _EXPERIENCE_TO_EXPERTISE.get(experience_key, 40),
        "hot_take_slider": _STYLE_TO_HOT_TAKE.get(style_key, 25),
        "favorite_players": extracted.get("favorite_players", []),
        "voice_key": "danny",
    }
    logger.info("Extracted profile: %s", profile_dict)

    return CallTranscriptResponse(transcript=transcript_text, profile=profile_dict)


@app.post("/api/start", response_model=StartResponse)
async def start_commentary(req: StartRequest):
    """Download a YouTube video and return a session for WebSocket commentary."""
    video = await download_video(
        url=req.url,
        output_dir=config.videos_dir,
        max_duration=config.max_video_duration,
    )

    session_id = str(uuid.uuid4())[:8]
    _sessions[session_id] = video

    logger.info("Session %s created for: %s (%ds)", session_id, video.title, video.duration)

    return StartResponse(
        session_id=session_id,
        title=video.title,
        duration=video.duration,
        video_url=f"/videos/{video.path.name}",
    )


# ---- Live streaming endpoint (Chrome Extension) ----
# NOTE: /ws/live must be registered BEFORE /ws/{session_id} so the literal
# path matches before the path-parameter route captures "live" as a session_id.

# Active live pipelines for cleanup
_active_live_pipelines: dict[str, LiveCommentaryPipeline] = {}


@app.websocket("/ws/live")
async def live_commentary_ws(ws: WebSocket):
    """WebSocket for Chrome Extension: receives JPEG frames, streams commentary back."""
    await ws.accept()
    session_id = str(uuid.uuid4())[:8]
    logger.info("Live WebSocket connected: session %s", session_id)

    pipeline = LiveCommentaryPipeline(ws=ws, skip_detection=config.skip_detection, sport="soccer")
    _active_live_pipelines[session_id] = pipeline

    try:
        await pipeline.initialize()

        while True:
            message = await ws.receive()

            if message.get("type") == "websocket.disconnect":
                break

            # Binary message = JPEG frame
            if "bytes" in message and message["bytes"]:
                await pipeline.process_frame(message["bytes"])

            # Text message = JSON command
            elif "text" in message and message["text"]:
                import json

                data = json.loads(message["text"])
                msg_type = data.get("type")

                if msg_type == "stop":
                    logger.info("Client requested stop for live session %s", session_id)
                    break

                elif msg_type == "set_persona":
                    # Select a pre-defined persona by key
                    persona_key = data.get("persona", "")
                    if persona_key in PERSONAS:
                        pipeline.set_profile(PERSONAS[persona_key])
                        await ws.send_json(
                            {"type": "status", "message": f"Persona: {PERSONAS[persona_key].name}"}
                        )
                    else:
                        logger.warning("Unknown persona: %s", persona_key)

                elif msg_type == "frame_ts":
                    # Capture timestamp from frontend for sync with delayed playback
                    pipeline._last_frame_ts = data.get("ts", 0.0)

                elif msg_type == "set_sport":
                    # Switch sport mid-session
                    sport = data.get("sport", "soccer")
                    pipeline.set_sport(sport)
                    await ws.send_json({"type": "status", "message": f"Sport set: {sport}"})

                elif msg_type == "set_profile":
                    # Set a custom profile from JSON
                    profile = UserProfile.from_dict(data.get("profile", {}))
                    pipeline.set_profile(profile)
                    await ws.send_json(
                        {"type": "status", "message": f"Profile set: {profile.name}"}
                    )

    except WebSocketDisconnect:
        logger.info("Live WebSocket disconnected: session %s", session_id)
    except Exception:
        logger.exception("Error in live commentary session %s", session_id)
    finally:
        await pipeline.stop()
        _active_live_pipelines.pop(session_id, None)
        logger.info("Live pipeline stopped: session %s", session_id)


# ---- File-based streaming endpoint (YouTube download mode) ----


@app.websocket("/ws/{session_id}")
async def commentary_ws(ws: WebSocket, session_id: str):
    """WebSocket endpoint that streams commentary for a session."""
    video = _sessions.get(session_id)
    if video is None:
        await ws.close(code=4004, reason="Session not found")
        return

    # If there's already an active pipeline for this session (e.g. React StrictMode
    # double-mount), stop it before starting a new one.
    existing = _active_pipelines.pop(session_id, None)
    if existing is not None:
        logger.info("Replacing existing pipeline for session %s", session_id)
        await existing.stop()

    await ws.accept()
    logger.info("WebSocket connected for session %s", session_id)

    pipeline = CommentaryPipeline(ws=ws, video_path=video.path)
    _active_pipelines[session_id] = pipeline

    try:
        await pipeline.run()
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected for session %s", session_id)
    finally:
        await pipeline.stop()
        _active_pipelines.pop(session_id, None)
        logger.info("Pipeline stopped for session %s", session_id)


# ---- Entry point ----

if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=config.server_port)
