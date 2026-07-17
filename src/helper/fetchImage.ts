/**
 * Downloads an image from a URL and returns it as a Blob.
 * Uses native fetch API with timeout and redirect handling.
 * Returns null if the download fails or the content is not an image.
 */
const FETCH_TIMEOUT_MS = 15000;

const fetchImage = async (url: string): Promise<Blob | null> => {
  try {
    // One deadline for headers AND body: a slow-drip server must not be able
    // to hold the worker open past the timeout (undici's own bodyTimeout is
    // idle-based and resets on every chunk).
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "MastodonNewsBot/2.0",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      console.log(`Image fetch failed (${response.status}): ${url}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      await response.body?.cancel().catch(() => {});
      console.log(`Not an image (${contentType}): ${url}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Blob([arrayBuffer], { type: contentType });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      console.log(`Image fetch timeout: ${url}`);
    } else {
      console.log(`Image fetch error for ${url}: ${e}`);
    }
    return null;
  }
};

export default fetchImage;
