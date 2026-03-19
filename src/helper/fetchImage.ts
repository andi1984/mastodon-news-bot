/**
 * Downloads an image from a URL and returns it as a Blob.
 * Uses native fetch API with timeout and redirect handling.
 * Returns null if the download fails or the content is not an image.
 */
const fetchImage = async (url: string): Promise<Blob | null> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "MastodonNewsBot/2.0",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`Image fetch failed (${response.status}): ${url}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      console.log(`Not an image (${contentType}): ${url}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Blob([arrayBuffer], { type: contentType });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      console.log(`Image fetch timeout: ${url}`);
    } else {
      console.log(`Image fetch error for ${url}: ${e}`);
    }
    return null;
  }
};

export default fetchImage;
