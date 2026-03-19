import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");
import createClient from "../helper/db.js";

// Create a single supabase client for interacting with your database
const supabase = createClient();

(async () => {
  const { data, error } = await supabase
    .from(settings.db_table)
    .delete()
    .eq("tooted", true)
    .select("id");

  console.log(`Deleted ${data?.length ?? 0} tooted entries`);

  if (error) {
    console.error(error.message);
  }

  // Optional filter for feed items within certain freshness interval (hours)
  if (!!settings.min_freshness_hours) {
    // https://github.com/supabase/supabase/discussions/3734#discussioncomment-1579562
    const minFreshnessDate = new Date();
    minFreshnessDate.setHours(
      minFreshnessDate.getHours() - settings.min_freshness_hours
    );

    console.log(`Cleaning up untooted items older than ${minFreshnessDate}.`);
    const { data: staleData, error: freshnessError } = await supabase
      .from(settings.db_table)
      .delete()
      .eq("tooted", false)
      .or(`pub_date.lte.${minFreshnessDate.toISOString()},created_at.lte.${minFreshnessDate.toISOString()}`)
      .select("id");

    console.log(`Cleaned up ${staleData?.length ?? 0} stale feed items.`);

    if (freshnessError) {
      console.error(freshnessError.message);
    }
  }

  // Clean up old stories (keep for 7 days after tooting, 3 days if not tooted)
  const tootedStoryCutoff = new Date();
  tootedStoryCutoff.setDate(tootedStoryCutoff.getDate() - 7);

  const { data: oldTootedStories, error: storyError1 } = await supabase
    .from("stories")
    .delete()
    .eq("tooted", true)
    .lt("updated_at", tootedStoryCutoff.toISOString())
    .select("id");

  if (storyError1) {
    console.error(`Failed to clean up old tooted stories: ${storyError1.message}`);
  } else {
    console.log(`Cleaned up ${oldTootedStories?.length ?? 0} old tooted stories.`);
  }

  const untootedStoryCutoff = new Date();
  untootedStoryCutoff.setDate(untootedStoryCutoff.getDate() - 3);

  const { data: oldUntootedStories, error: storyError2 } = await supabase
    .from("stories")
    .delete()
    .eq("tooted", false)
    .lt("updated_at", untootedStoryCutoff.toISOString())
    .select("id");

  if (storyError2) {
    console.error(`Failed to clean up old untooted stories: ${storyError2.message}`);
  } else {
    console.log(`Cleaned up ${oldUntootedStories?.length ?? 0} old untooted stories.`);
  }

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
