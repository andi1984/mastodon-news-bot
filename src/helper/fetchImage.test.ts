import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const { default: fetchImage } = await import("./fetchImage.js");

describe("fetchImage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns a Blob for a valid image response", async () => {
    const imageData = new Uint8Array([137, 80, 78, 71]); // PNG header bytes
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(imageData, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );

    const result = await fetchImage("https://example.com/image.png");
    expect(result).toBeInstanceOf(Blob);
    expect(result!.type).toBe("image/png");
  });

  test("returns null for non-image content-type", async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response("not an image", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );

    const result = await fetchImage("https://example.com/page.html");
    expect(result).toBeNull();
  });

  test("returns null for HTTP error status", async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 404 })
    );

    const result = await fetchImage("https://example.com/missing.png");
    expect(result).toBeNull();
  });

  test("returns null for 500 server error", async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 500 })
    );

    const result = await fetchImage("https://example.com/error.png");
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed")
    );

    const result = await fetchImage("https://example.com/image.png");
    expect(result).toBeNull();
  });

  test("returns null on abort/timeout", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(abortError);

    const result = await fetchImage("https://example.com/slow-image.png");
    expect(result).toBeNull();
  });

  test("handles missing content-type header", async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {},
      })
    );

    const result = await fetchImage("https://example.com/unknown");
    expect(result).toBeNull();
  });

  test("handles image/jpeg content-type", async () => {
    const jpegData = new Uint8Array([0xff, 0xd8, 0xff]);
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(jpegData, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );

    const result = await fetchImage("https://example.com/photo.jpg");
    expect(result).toBeInstanceOf(Blob);
    expect(result!.type).toBe("image/jpeg");
  });
});
