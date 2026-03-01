import https from "https";
import http from "http";

/**
 * Downloads an image from a URL and returns it as a Blob.
 * Returns null if the download fails or the content is not an image.
 */
const fetchImage = (url: string): Promise<Blob | null> => {
	return new Promise((resolve) => {
		const client = url.startsWith("https") ? https : http;

		client
			.get(url, (res) => {
				// Follow redirects
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location
				) {
					fetchImage(res.headers.location).then(resolve);
					return;
				}

				if (!res.statusCode || res.statusCode >= 400) {
					console.log(`Image fetch failed (${res.statusCode}): ${url}`);
					resolve(null);
					return;
				}

				const contentType = res.headers["content-type"] || "";
				if (!contentType.startsWith("image/")) {
					console.log(`Not an image (${contentType}): ${url}`);
					resolve(null);
					return;
				}

				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const buffer = Buffer.concat(chunks);
					resolve(new Blob([buffer], { type: contentType }));
				});
				res.on("error", (e) => {
					console.log(`Image download error for ${url}: ${e}`);
					resolve(null);
				});
			})
			.on("error", (e) => {
				console.log(`Image fetch error for ${url}: ${e}`);
				resolve(null);
			});
	});
};

export default fetchImage;
