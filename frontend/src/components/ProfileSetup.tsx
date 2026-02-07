/**
 * ProfileSetup - User profile form for personalization.
 *
 * TODO: Implement after /plan p1-user-profiles
 * - Name, favorite team, rival team
 * - Expertise slider (0-100)
 * - Hot take slider (0-100)
 * - Alma mater, hometown
 * - Favorite players (multi-select or freeform)
 */

interface ProfileSetupProps {
  onComplete: (profile: UserProfileData) => void;
}

export interface UserProfileData {
  name: string;
  favoriteTeam: string | null;
  rivalTeam: string | null;
  expertiseSlider: number;
  hotTakeSlider: number;
  almaMater: string | null;
  hometown: string | null;
  favoritePlayers: string[];
  interests: string[];
}

export function ProfileSetup({ onComplete }: ProfileSetupProps) {
  return (
    <div className="profile-setup">
      <h2>Set Up Your Profile</h2>
      <p>TODO: Build profile form</p>
      <button
        onClick={() =>
          onComplete({
            name: "Fan",
            favoriteTeam: "Kansas City Chiefs",
            rivalTeam: null,
            expertiseSlider: 50,
            hotTakeSlider: 50,
            almaMater: null,
            hometown: null,
            favoritePlayers: [],
            interests: [],
          })
        }
      >
        Use Defaults
      </button>
    </div>
  );
}
