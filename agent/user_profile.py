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

    # Deep personalization
    alma_mater: str | None = None
    hometown: str | None = None
    favorite_players: list[str] = field(default_factory=list)
    interests: list[str] = field(default_factory=list)

    # Enriched by research agent
    players_from_alma_mater: list[dict] = field(default_factory=list)
    hometown_connections: list[str] = field(default_factory=list)
    fun_facts: list[str] = field(default_factory=list)

    def get_expertise_description(self) -> str:
        """Convert expertise slider to description."""
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

    def build_prompt_block(self) -> str:
        """Build a personalization block to append to the system prompt."""
        lines = ["\n## Viewer Profile\n"]
        lines.append(f"- **Name:** {self.name}")

        if self.favorite_team:
            lines.append(f"- **Favorite team:** {self.favorite_team}")
            if self.rival_team:
                lines.append(f"- **Rival team:** {self.rival_team}")

        lines.append(f"- **Expertise:** {self.get_expertise_description()}")
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
            alma_mater=data.get("alma_mater"),
            hometown=data.get("hometown"),
            favorite_players=data.get("favorite_players", []),
            interests=data.get("interests", []),
        )


# ---- Pre-defined Personas ----

PERSONAS: dict[str, UserProfile] = {
    "casual_fan": UserProfile(
        name="Alex",
        favorite_team="Barcelona",
        expertise_slider=35,
        hot_take_slider=45,
        favorite_players=["Lamine Yamal", "Pedri"],
    ),
    "new_to_soccer": UserProfile(
        name="Jordan",
        expertise_slider=10,
        hot_take_slider=20,
        interests=["learning the rules", "understanding positions"],
    ),
    "tactical_nerd": UserProfile(
        name="Sam",
        favorite_team="Manchester City",
        rival_team="Arsenal",
        expertise_slider=95,
        hot_take_slider=30,
        favorite_players=["Kevin De Bruyne", "Rodri", "Erling Haaland"],
        interests=["pressing systems", "expected goals", "set piece design"],
    ),
    "passionate_homer": UserProfile(
        name="Danny",
        favorite_team="Liverpool",
        rival_team="Manchester United",
        expertise_slider=60,
        hot_take_slider=90,
        favorite_players=["Mohamed Salah", "Virgil van Dijk"],
    ),
}
