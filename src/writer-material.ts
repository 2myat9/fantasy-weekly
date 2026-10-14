// The material for the writer: which of the source items gathered on a
// league's players it is handed. What it is not handed it cannot write about,
// so the rules that can be decided here are not left to the model.
import { gameOf, type WeekSchedule } from "./espn";
import type { SourceItem } from "./news";
import type { League, Player, RosterSpot } from "./sleeper";

// A kicker is covered through injury or job news only, so that kicker lines
// are not filler. Items carry no topic, so their wording is gone by: an ESPN
// designation other than fit to play, or a word that injury reports and
// roster moves use. Missing counts only when it is practice, time or games
// that are missed, not kicks, which recaps of a kicker's game count. A
// doubtful item is let through for the writer to judge.
const KICKER_NEWS =
  /ESPN status: (?!Active)|\b(injur\w*|hurt|ill(ness)?|strain\w*|sprain\w*|sore\w*|surgery|questionable|doubtful|out|miss(es|ed|ing)? ((?!kicks?\b|field\b|FGs?\b|PATs?\b|extra\b|attempts?\b)\S+ ){0,4}(practice|time|games?|contests?|matchups?|weeks?|season)\b(?!-)|inactive|limited|did not practice|sidelined|suspen\w+|IR|reserve|sign(s|ed|ing)?|waive[sd]?|release[sd]?|cut|work(s|ed)? out|workouts?|tryouts?|compet\w+|bench(ed)?|replac\w+|practice squad|elevat\w+|claim(s|ed)?|trade[sd]?)\b/i;

/**
 * The source items the writer is handed for one league, and the players on
 * the user's roster whose game this week has kicked off.
 *
 * What was reported about a player before their game kicked off bears on a
 * slot that is now locked, so only what came since is kept: that is where an
 * injury in the game shows. This goes for the opponent's players too. The
 * items are in roster order, so starters come first, and the opponent's come
 * last.
 */
export function writerMaterial({
  league,
  roster,
  players,
  schedule,
  items,
  now
}: {
  league: League;
  roster: RosterSpot[];
  players: Map<string, Player>;
  schedule: WeekSchedule;
  items: SourceItem[];
  now: Date;
}): { items: SourceItem[]; kickedOff: Set<string> } {
  // When a player's game kicked off, if it has.
  const kickoff = (playerId: string) => {
    const game = gameOf(schedule, players.get(playerId)?.team ?? null);
    return game && game.kickoff <= now ? game.kickoff : undefined;
  };
  const since = (playerId: string) => {
    const from = kickoff(playerId);
    return items.filter(
      (item) => item.playerId === playerId && (!from || item.date >= from)
    );
  };
  const mine = roster.flatMap(({ playerId }) =>
    players.get(playerId)?.position === "K"
      ? since(playerId).filter((item) => KICKER_NEWS.test(item.text))
      : since(playerId)
  );
  const theirs = league.opponent.flatMap(({ playerId }) => since(playerId));
  return {
    items: [...mine, ...theirs],
    kickedOff: new Set(
      roster.flatMap(({ playerId }) => (kickoff(playerId) ? playerId : []))
    )
  };
}
