import Parser from "rss-parser";

let parser = new Parser();

const getFeed = async(feed:string) => {
  console.log("Parsing feed");
  return await parser.parseURL(feed);
};

export default getFeed;
