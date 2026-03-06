import Parser from "rss-parser";

let parser = new Parser();

const getFeed = async(feed:string): Promise<{ items: any[] } | null> => {
  console.log("Parsing feed:", feed);
  try {
    return await parser.parseURL(feed);
  } catch (error: any) {
    const statusMatch = error?.message?.match(/Status code (\d+)/);
    const statusCode = statusMatch ? statusMatch[1] : null;

    if (statusCode === '503' || statusCode === '502' || statusCode === '504') {
      console.warn(`Feed temporarily unavailable (${statusCode}): ${feed}`);
    } else {
      console.error(`Failed to fetch feed ${feed}:`, error?.message || error);
    }
    return null;
  }
};

export default getFeed;
