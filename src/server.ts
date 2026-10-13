import { Agent } from "agents";

// The system is single-user, so there is exactly one agent instance.
export const AGENT_NAME = "fantasy-weekly";

export type RunRecord = {
  at: string;
  season: string;
  seasonType: string;
  week: number;
};

type State = { lastRun: RunRecord | null };

export class FantasyWeeklyAgent extends Agent<Env, State> {
  initialState: State = { lastRun: null };

  // Placeholder run: it only records which NFL week Sleeper reports. The
  // digest pipeline replaces it.
  async scheduledRun() {
    const response = await fetch("https://api.sleeper.app/v1/state/nfl");
    if (!response.ok) {
      throw new Error(`Sleeper NFL state returned ${response.status}`);
    }
    const nfl = await response.json<{
      season: string;
      season_type: string;
      week: number;
    }>();
    this.setState({
      lastRun: {
        at: new Date().toISOString(),
        season: nfl.season,
        seasonType: nfl.season_type,
        week: nfl.week
      }
    });
  }

  lastRun() {
    return this.state.lastRun;
  }
}

export default {
  // The HTTP surface is empty until the Telegram webhook is added.
  async fetch() {
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
