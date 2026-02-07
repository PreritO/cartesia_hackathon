"""User profile for personalized commentary."""

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

    @classmethod
    def default(cls) -> "UserProfile":
        """Default profile for demo."""
        return cls(
            name="Fan",
            favorite_team="Kansas City Chiefs",
            expertise_slider=50,
            hot_take_slider=50,
        )

    def get_expertise_description(self) -> str:
        """Convert expertise slider to description."""
        if self.expertise_slider < 20:
            return "Complete beginner - explain everything simply"
        elif self.expertise_slider < 50:
            return "Casual fan - knows basics, explain complex plays"
        elif self.expertise_slider < 80:
            return "Knowledgeable - appreciates tactical analysis"
        else:
            return "Film room nerd - loves X's and O's, deep analysis"

    def get_style_instruction(self) -> str:
        """Get commentary style based on hot take slider."""
        if self.hot_take_slider < 30:
            return "balanced and objective"
        elif self.hot_take_slider < 60:
            return "engaged with some team bias"
        else:
            return "full homer mode - celebrate your team, mock the rivals"

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

        return "; ".join(connections) if connections else "No special connections"
