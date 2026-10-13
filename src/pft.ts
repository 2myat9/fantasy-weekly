// The ProFootballTalk client: the latest entries of its public feed. The feed
// is RSS, and the runtime has no XML parser, so the few fields used are cut
// out of the text.
const FEED = "https://www.nbcsports.com/profootballtalk.rss";

/** One entry of the feed. */
export type FeedEntry = {
  title: string;
  /** The entry's opening lines. */
  summary: string;
  date: Date;
  link: string;
};

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&"
};

function decode(text: string) {
  return text.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
    const code =
      name[1].toLowerCase() === "x"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
    // A number that is no character is left as it was written.
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// The text of an element of an entry, or empty when the entry has none.
function field(entry: string, tag: string) {
  const text =
    entry.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
  const cdata = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decode(cdata ? cdata[1] : text).trim();
}

/** The latest entries, about 30 of them, which is under a day of the feed. */
export async function fetchProFootballTalk(): Promise<FeedEntry[]> {
  const response = await fetch(FEED);
  if (!response.ok) {
    throw new Error(`ProFootballTalk returned ${response.status}`);
  }
  const feed = await response.text();
  return feed
    .split("<item>")
    .slice(1)
    .flatMap((entry) => {
      const title = field(entry, "title");
      const link = field(entry, "link");
      const date = new Date(field(entry, "pubDate"));
      // An entry that cannot be dated or linked cannot be cited.
      if (!title || !link || isNaN(date.getTime())) return [];
      return { title, summary: field(entry, "description"), date, link };
    });
}
