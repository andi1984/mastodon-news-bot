import Parser from "rss-parser";

// Reuse parser instance across calls (avoid re-creating)
const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "MastodonNewsBot/2.0 (RSS Reader)",
    Accept: "application/rss+xml, application/xml, text/xml",
  },
  maxRedirects: 3,
});

const getFeed = async (feed: string): Promise<{ items: any[] } | null> => {
  console.log("Parsing feed:", feed);
  try {
    return await parser.parseURL(feed);
  } catch (error: any) {
    const statusMatch = error?.message?.match(/Status code (\d+)/);
    const statusCode = statusMatch ? statusMatch[1] : null;

    if (statusCode === "503" || statusCode === "502" || statusCode === "504") {
      console.warn(`Feed temporarily unavailable (${statusCode}): ${feed}`);
    } else {
      console.error(`Failed to fetch feed ${feed}:`, error?.message || error);
    }
    return null;
  }
};

export default getFeed;
