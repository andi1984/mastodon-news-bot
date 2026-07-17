import Parser from "rss-parser";

// Fetch the XML ourselves instead of using parser.parseURL():
// rss-parser's own network layer never destroys the request on timeout,
// non-2xx, or redirect (rbren/rss-parser#238, unfixed upstream), leaving the
// socket open and the response buffering for the rest of the worker's life.
// Native fetch aborts the transfer for real via AbortSignal.timeout.
const FETCH_TIMEOUT_MS = 15000;

const FETCH_HEADERS = {
  "User-Agent": "MastodonNewsBot/2.0 (RSS Reader)",
  Accept: "application/rss+xml, application/xml, text/xml",
};

// Reuse parser instance across calls (avoid re-creating)
const parser = new Parser();

/**
 * Decode the response body honoring the charset from the Content-Type header
 * (some German feeds still serve ISO-8859-1); falls back to UTF-8, matching
 * rss-parser's own behavior.
 */
const decodeBody = (buffer: ArrayBuffer, contentType: string | null): string => {
  const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim();
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
};

const getFeed = async (feed: string): Promise<{ items: any[] } | null> => {
  console.log("Parsing feed:", feed);
  try {
    const response = await fetch(feed, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: FETCH_HEADERS,
      redirect: "follow",
    });

    if (!response.ok) {
      // Release the connection before bailing; the message format matches
      // rss-parser's so the status-code handling below keeps working.
      await response.body?.cancel().catch(() => {});
      throw new Error(`Status code ${response.status}`);
    }

    const xml = decodeBody(
      await response.arrayBuffer(),
      response.headers.get("content-type")
    );
    return await parser.parseString(xml);
  } catch (error: any) {
    const statusMatch = error?.message?.match(/Status code (\d+)/);
    const statusCode = statusMatch ? statusMatch[1] : null;

    if (statusCode === "503" || statusCode === "502" || statusCode === "504") {
      console.warn(`Feed temporarily unavailable (${statusCode}): ${feed}`);
    } else if (error?.name === "TimeoutError") {
      console.warn(`Feed timed out after ${FETCH_TIMEOUT_MS}ms: ${feed}`);
    } else {
      console.error(`Failed to fetch feed ${feed}:`, error?.message || error);
    }
    return null;
  }
};

export default getFeed;
