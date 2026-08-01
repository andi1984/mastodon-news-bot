/**
 * Downloads an image from a URL and returns it as a Blob.
 * Uses native fetch API with timeout and redirect handling.
 * Returns null if the download fails or the content is not an image.
 */
const FETCH_TIMEOUT_MS = 15000;

const fetchImage = async (url: string): Promise<Blob | null> => {
  // One deadline for headers AND body: a slow-drip server must not be able
  // to hold the worker open past the timeout (undici's own bodyTimeout is
  // idle-based and resets on every chunk). Own AbortController instead of
  // AbortSignal.timeout: Node 24.16+ retains fetch buffers after
  // AbortSignal.timeout aborts (nodejs/node#63708); the abort reason keeps
  // the TimeoutError name the catch below expects.
  const ac = new AbortController();
  const timeoutId = setTimeout(
    () =>
      ac.abort(
        new DOMException(
          `Image fetch timed out after ${FETCH_TIMEOUT_MS}ms`,
          "TimeoutError",
        ),
      ),
    FETCH_TIMEOUT_MS,
  );
  timeoutId.unref?.();
  try {
    const response = await fetch(url, {
      signal: ac.signal,
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
  } finally {
    clearTimeout(timeoutId);
  }
};

export default fetchImage;
