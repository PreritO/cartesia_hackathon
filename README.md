# AI Sports Commentator

Real-time, personalized AI commentary for any sports video playing in your browser. A Chrome Extension captures video frames from YouTube (or any streaming platform), streams them to a backend powered by Claude and Cartesia, and delivers synchronized play-by-play, tactical analysis, and personalized reactions — all with expressive text-to-speech.

Built for the **Cartesia x Anthropic x Notion Voice Agent Hackathon**.

## How It Works

```
YouTube Tab                          Chrome Extension Side Panel
┌──────────────────────┐             ┌──────────────────────────────┐
│                      │  frames     │  Synced delayed video        │
│  <video> element ────┼────────────►│  ┌──────────────────────┐   │
│                      │  (15 FPS)   │  │ ▶ Delayed playback   │   │
│  [AI Commentary      │             │  └──────────────────────┘   │
│   Active — watch     │             │                              │
│   in sidebar]        │             │  🏈 Football  ⚽ Soccer      │
│                      │             │                              │
└──────────────────────┘             │  ┌──────────────────────┐   │
                                     │  │ DANNY        excited │   │
        every 5th frame (3 FPS)      │  │ TOUCHDOWN! What a    │   │
             via WebSocket           │  │ run by #26!          │   │
                  │                  │  ├──────────────────────┤   │
                  ▼                  │  │ COACH KAY  thoughtful│   │
        ┌─────────────────┐          │  │ That play-action     │   │
        │  FastAPI Backend │          │  │ froze the safety...  │   │
        │                  │          │  ├──────────────────────┤   │
        │  Claude Sonnet   │ text +   │  │ ROOKIE     celebra. │   │
        │  (multimodal) ──►│ TTS ────►│  │ YOUR GUY did it,    │   │
        │                  │ audio    │  │ Prerit! LET'S GO!   │   │
        │  Cartesia Sonic-3│          │  └──────────────────────┘   │
        └─────────────────┘          └──────────────────────────────┘
```

### The Pipeline

1. **Content script** captures frames from YouTube's `<video>` element via offscreen canvas at 15 FPS
2. **Side panel** buffers all frames for smooth delayed playback, forwards every 5th frame (3 FPS) to the backend over WebSocket
3. **Backend** sends each frame to **Claude Sonnet 4.5** (multimodal) with sport-specific system prompts and the viewer's profile for personalized commentary
4. **Cartesia Sonic-3** synthesizes the commentary text into expressive speech with emotion-driven voice modulation
5. **Side panel** schedules commentary + audio to arrive in sync with the delayed video playback

### Key Features

- **Voice onboarding** — Talk to Danny (your lead commentator) via Cartesia's voice agent before the game starts. He learns your name, favorite team, players, and how you like your commentary. The transcript is extracted via the Cartesia API and used to build your viewer profile.
- **Multi-analyst team** — Three distinct AI commentators rotate naturally:
  - **Danny** (play-by-play) — calls the action, paints the picture
  - **Coach Kay** (tactical analyst) — breaks down formations, schemes, and strategy
  - **Rookie** (viewer's buddy) — personal reactions, rule explanations, uses your name and favorite players
- **Emotion-driven TTS** — Commentary includes emotion tags (`[EMOTION:excited]`, `[EMOTION:tense]`, etc.) that map to Cartesia voice speed/tone parameters for natural, expressive delivery
- **Multi-sport support** — Toggle between American Football and Soccer with sport-specific prompts, terminology, and zone labeling
- **Synced delayed playback** — Calibrate-then-play strategy measures actual processing latency, locks a delay, and plays video + commentary in perfect sync
- **Play/pause** — Pause freezes both the YouTube video and commentary; resume catches up seamlessly with timeline-shifting logic
- **Optional RF-DETR detection** — When enabled, runs local object detection (RF-DETR) for ball tracking, player counting, and scene classification to enrich commentary context

## Project Structure

```
cartesia_hackathon/
├── agent/                              # Python backend
│   ├── server.py                       # FastAPI server (REST + WebSocket)
│   ├── pipeline.py                     # Commentary pipeline (detection → LLM → TTS)
│   ├── config.py                       # Environment config
│   ├── user_profile.py                 # Viewer profile + personas
│   ├── video_download.py               # YouTube download fallback (yt-dlp)
│   ├── instructions/                   # LLM system prompts
│   │   ├── commentary.md               # Shared rules (soccer)
│   │   ├── commentary_football.md      # Shared rules (American football)
│   │   ├── danny.md                    # Danny persona (soccer)
│   │   ├── danny_football.md           # Danny persona (football)
│   │   ├── coach_kay.md                # Coach Kay persona (soccer)
│   │   ├── coach_kay_football.md       # Coach Kay persona (football)
│   │   ├── rookie.md                   # Rookie persona (soccer)
│   │   └── rookie_football.md          # Rookie persona (football)
│   └── processors/
│       └── events.py                   # Detection event types
├── extension/                          # Chrome Extension (WXT + React)
│   ├── wxt.config.ts                   # Extension manifest config
│   ├── entrypoints/
│   │   ├── content.ts                  # Content script (frame capture from <video>)
│   │   ├── background.ts               # Service worker (side panel toggle)
│   │   ├── sidepanel/
│   │   │   ├── App.tsx                 # Main streaming UI
│   │   │   ├── ProfileSetup.tsx        # Voice onboarding + profile form
│   │   │   ├── DetectionDebug.tsx      # Detection overlay (debug)
│   │   │   └── YouTubePlayer.tsx       # YouTube embed component
│   │   └── offscreen/                  # Offscreen document (audio capture)
│   └── lib/
│       ├── constants.ts                # Backend URL, FPS settings
│       └── messages.ts                 # Type definitions
├── pyproject.toml                      # Python deps (uv/pip)
├── .env.example                        # Required env vars template
└── README.md
```

## Setup & Run

### Prerequisites

- Python 3.10+
- Node.js 18+
- Chrome 116+
- API keys: [Anthropic](https://console.anthropic.com/), [Cartesia](https://cartesia.ai/)

### 1. Clone & configure environment

```bash
git clone https://github.com/yourusername/cartesia_hackathon.git
cd cartesia_hackathon

# Copy and fill in your API keys
cp .env.example .env
```

Required environment variables in `.env`:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `CARTESIA_API_KEY` | Cartesia API key for TTS + voice agent |
| `VOICE_ID_DANNY` | Cartesia voice ID for Danny (energetic male) |
| `VOICE_ID_COACH_KAY` | Cartesia voice ID for Coach Kay (warm, authoritative) |
| `VOICE_ID_ROOKIE` | Cartesia voice ID for Rookie (casual, friendly) |

Optional:
| Variable | Default | Description |
|----------|---------|-------------|
| `RFDETR_MODEL_ID` | `rfdetr-base` | RF-DETR model size (`rfdetr-base` or `rfdetr-large`) |
| `SKIP_DETECTION` | `true` | Skip RF-DETR, send frames directly to Claude |
| `SERVER_PORT` | `8000` | Backend server port |

### 2. Install & start the backend

```bash
# Create virtual environment and install dependencies
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Start the server
python -m agent.server
```

The server runs at `http://localhost:8000`. Health check: `GET /api/health`.

### 3. Build & load the Chrome Extension

```bash
cd extension
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/.output/chrome-mv3` directory

### 4. Use it

1. Open any YouTube video in a tab (sports highlights work best)
2. Click the AI Sports Commentator extension icon — the side panel opens
3. **Voice onboarding**: Talk to Danny, tell him your name and preferences (or skip)
4. **Confirm your profile**: Review and adjust what Danny learned
5. **Select your sport**: Toggle between Football and Soccer
6. Click **Start Stream**
7. The YouTube tab's video gets an overlay; synced playback + commentary appears in the sidebar
8. Use the play/pause button to control both video and commentary together

## Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| LLM | **Claude Sonnet 4.5** (Anthropic) | Multimodal commentary generation — sees the video frame + detection context |
| TTS | **Cartesia Sonic-3** | Expressive speech synthesis with emotion-driven speed/tone |
| Voice Agent | **Cartesia Agents API** | Real-time voice onboarding conversation |
| Detection | **RF-DETR** (local, optional) | Object detection for ball tracking and scene classification |
| Backend | **FastAPI** + **WebSocket** | Frame ingestion, pipeline orchestration, streaming results |
| Extension | **WXT** + **React** + **TypeScript** | Chrome Extension framework with side panel UI |
| Video Capture | **Chrome Content Script** | Reads `<video>` pixels via offscreen canvas |

## Architecture Details

### Sync Strategy: Calibrate-then-Play

The core challenge is that there's a variable delay (~4-8s) between capturing a frame and receiving commentary. We solve this with a fixed-delay approach:

1. First 2 commentaries are used to **measure** actual processing latency
2. The worst-case latency + a buffer becomes the **locked delay**
3. Video plays back at `now - lockedDelay`, so commentary arrives exactly when the viewer sees the corresponding frame
4. On pause/resume, the delay shifts forward by the pause duration to keep everything aligned

### Emotion → Voice Mapping

The LLM outputs emotion tags that control Cartesia's TTS parameters:

| Emotion | Speed | Use Case |
|---------|-------|----------|
| `excited` | 1.2x | Goals, big plays, momentum shifts |
| `tense` | 1.1x | 4th down, penalty kicks, final seconds |
| `thoughtful` | 1.1x | Tactical analysis, replays |
| `celebratory` | 1.3x | Touchdowns, hat tricks |
| `disappointed` | 1.0x | Turnovers, missed chances |
| `urgent` | 1.2x | Two-minute drill, stoppage time |

### Analyst Rotation

Analysts are selected based on scene classification and rotation rules:
- **Danny** (~55%): Active play, transitions — the primary voice
- **Coach Kay** (~30%): Lulls, close-ups, post-play analysis
- **Rookie** (~15%): Every 4th commentary when viewer has personal context

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agent-token` | Mint a Cartesia access token for voice onboarding |
| `POST` | `/api/call-transcript` | Fetch latest voice call transcript + extract profile |
| `POST` | `/api/extract-profile` | Extract profile from a text transcript |
| `POST` | `/api/profile-chat` | Text-based profile chat (legacy) |
| `POST` | `/api/start` | Download a YouTube video (file-based fallback) |
| `WS` | `/ws/live` | Live frame streaming + commentary (Chrome Extension) |
| `WS` | `/ws/{session_id}` | File-based commentary streaming |
| `GET` | `/api/health` | Health check |

### WebSocket Protocol (`/ws/live`)

**Client → Server:**
- Binary: JPEG frame bytes
- `{"type": "frame_ts", "ts": 1234567890}` — Frame capture timestamp
- `{"type": "set_sport", "sport": "football"}` — Switch sport
- `{"type": "set_profile", "profile": {...}}` — Set viewer profile
- `{"type": "stop"}` — End session

**Server → Client:**
- `{"type": "status", "message": "..."}` — Status updates
- `{"type": "commentary", "text": "...", "emotion": "excited", "analyst": "Danny", "audio": "<base64>", "frame_ts": 123}` — Commentary + TTS audio
- `{"type": "detection", "annotated_frame": "<base64>", "person_count": 8, "ball_count": 1}` — Detection debug info

## Development

```bash
# Backend (auto-reload)
cd /path/to/cartesia_hackathon
source .venv/bin/activate
uvicorn agent.server:app --reload --host 0.0.0.0 --port 8000

# Extension (dev mode with hot reload)
cd extension
npm run dev
```

## Hackathon Context

**Problem Statements Addressed:**
- **Statement One (Expressive)**: Emotion-tagged commentary drives Cartesia TTS parameters for natural, expressive delivery that matches the energy of live sports
- **Statement Two (Advanced Reasoning)**: Claude analyzes video frames multimodally, maintains game context across commentary, and personalizes output based on viewer expertise, team loyalty, and personal connections

**What makes this different:**
- Not just "describe what you see" — it's a full broadcast booth experience with three distinct analyst personalities
- Voice onboarding via Cartesia's agent API creates a genuine personal connection before the game starts
- Commentary is synced to delayed video so it feels like watching a real broadcast, not a laggy demo
- Works with any video platform (YouTube, Peacock, ESPN+) since we capture rendered pixels, not source video
