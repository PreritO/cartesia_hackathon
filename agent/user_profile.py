"""User profile for personalized commentary."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class UserProfile:
    """User profile for personalized commentary."""

    # Basic info
    name: str = "Fan"
    favorite_team: str | None = None
    rival_team: str | None = None

    # Sliders (0-100)
    expertise_slider: int = 50  # 0 = newbie, 100 = film nerd
    hot_take_slider: int = 50  # 0 = neutral, 100 = full homer

    # Voice: "danny", "coach_kay", or "rookie" — maps to VOICE_ID_* env vars
    voice_key: str = "danny"

    # Deep personalization
    alma_mater: str | None = None
    hometown: str | None = None
    favorite_players: list[str] = field(default_factory=list)
    interests: list[str] = field(default_factory=list)

    # Enriched by research agent
    players_from_alma_mater: list[dict] = field(default_factory=list)
    hometown_connections: list[str] = field(default_factory=list)
    fun_facts: list[str] = field(default_factory=list)

    def get_expertise_description(self, sport: str = "soccer") -> str:
        """Convert expertise slider to description."""
        if sport == "football":
            if self.expertise_slider < 20:
                return "Complete beginner — explain everything simply, define terms like downs, first down, touchdown, field goal, etc."
            elif self.expertise_slider < 50:
                return "Casual fan — knows the basics, explain formations, play types, and penalties"
            elif self.expertise_slider < 80:
                return "Knowledgeable — appreciates X's and O's, coverage schemes, route concepts"
            else:
                return "Film room nerd — loves pre-snap reads, blitz packages, RPOs, coverage shells, advanced football analytics"
        else:
            if self.expertise_slider < 20:
                return "Complete beginner — explain everything simply, define terms like offside, free kick, etc."
            elif self.expertise_slider < 50:
                return "Casual fan — knows the basics, explain complex plays and tactics"
            elif self.expertise_slider < 80:
                return "Knowledgeable — appreciates tactical analysis, use real football language"
            else:
                return "Film room nerd — loves formations, pressing triggers, expected goals, deep tactical breakdowns"

    def get_style_instruction(self) -> str:
        """Get commentary style based on hot take slider."""
        if self.hot_take_slider < 30:
            return "balanced and objective — call it fair for both sides"
        elif self.hot_take_slider < 60:
            return "engaged with some team bias — show extra energy for the viewer's team"
        else:
            return "full homer mode — celebrate your team, show empathy on bad plays, light trash talk for rivals"

    def get_connections_summary(self) -> str:
        """Summarize personal connections for the LLM."""
        connections = []
        if self.favorite_players:
            connections.append(f"Favorite players: {', '.join(self.favorite_players)}")
        if self.players_from_alma_mater:
            names = [p.get("name", "Unknown") for p in self.players_from_alma_mater[:3]]
            connections.append(f"Players from {self.alma_mater}: {', '.join(names)}")
        if self.hometown_connections:
            connections.append(f"Hometown connections: {', '.join(self.hometown_connections[:2])}")
        return "; ".join(connections) if connections else ""

    def build_prompt_block(self, sport: str = "soccer") -> str:
        """Build a personalization block to append to the system prompt."""
        lines = ["\n## Viewer Profile\n"]
        lines.append(f"- **Name:** {self.name}")

        if self.favorite_team:
            lines.append(f"- **Favorite team:** {self.favorite_team}")
            if self.rival_team:
                lines.append(f"- **Rival team:** {self.rival_team}")

        lines.append(f"- **Expertise:** {self.get_expertise_description(sport=sport)}")
        lines.append(f"- **Commentary style:** {self.get_style_instruction()}")

        connections = self.get_connections_summary()
        if connections:
            lines.append(f"- **Personal connections:** {connections}")

        if self.interests:
            lines.append(f"- **Interests:** {', '.join(self.interests)}")

        return "\n".join(lines)

    @classmethod
    def from_dict(cls, data: dict) -> UserProfile:
        """Create a UserProfile from a JSON-serializable dict."""
        return cls(
            name=data.get("name", "Fan"),
            favorite_team=data.get("favorite_team"),
            rival_team=data.get("rival_team"),
            expertise_slider=data.get("expertise_slider", 50),
            hot_take_slider=data.get("hot_take_slider", 50),
            voice_key=data.get("voice_key", "danny"),
            alma_mater=data.get("alma_mater"),
            hometown=data.get("hometown"),
            favorite_players=data.get("favorite_players", []),
            interests=data.get("interests", []),
        )


# ---- Pre-defined Personas ----

PERSONAS: dict[str, UserProfile] = {
    # Soccer personas
    "casual_fan": UserProfile(
        name="Alex",
        favorite_team="Barcelona",
        expertise_slider=35,
        hot_take_slider=45,
        voice_key="danny",
        favorite_players=["Lamine Yamal", "Pedri"],
    ),
    "new_to_soccer": UserProfile(
        name="Jordan",
        expertise_slider=10,
        hot_take_slider=20,
        voice_key="rookie",
        interests=["learning the rules", "understanding positions"],
    ),
    "tactical_nerd": UserProfile(
        name="Sam",
        favorite_team="Manchester City",
        rival_team="Arsenal",
        expertise_slider=95,
        hot_take_slider=30,
        voice_key="coach_kay",
        favorite_players=["Kevin De Bruyne", "Rodri", "Erling Haaland"],
        interests=["pressing systems", "expected goals", "set piece design"],
    ),
    "passionate_homer": UserProfile(
        name="Danny",
        favorite_team="Liverpool",
        rival_team="Manchester United",
        expertise_slider=60,
        hot_take_slider=90,
        voice_key="danny",
        favorite_players=["Mohamed Salah", "Virgil van Dijk"],
    ),
    # American Football personas
    "football_casual": UserProfile(
        name="Alex",
        favorite_team="Kansas City Chiefs",
        expertise_slider=35,
        hot_take_slider=45,
        voice_key="danny",
        favorite_players=["Patrick Mahomes", "Travis Kelce"],
    ),
    "football_newbie": UserProfile(
        name="Jordan",
        expertise_slider=10,
        hot_take_slider=20,
        voice_key="rookie",
        interests=["learning the rules", "understanding positions and downs"],
    ),
    "football_film_nerd": UserProfile(
        name="Sam",
        favorite_team="San Francisco 49ers",
        rival_team="Dallas Cowboys",
        expertise_slider=95,
        hot_take_slider=30,
        voice_key="coach_kay",
        favorite_players=["Brock Purdy", "Nick Bosa", "Christian McCaffrey"],
        interests=["coverage schemes", "run-pass options", "blitz packages"],
    ),
    "football_homer": UserProfile(
        name="Danny",
        favorite_team="Philadelphia Eagles",
        rival_team="Dallas Cowboys",
        expertise_slider=60,
        hot_take_slider=90,
        voice_key="danny",
        favorite_players=["Jalen Hurts", "Saquon Barkley"],
    ),
}
