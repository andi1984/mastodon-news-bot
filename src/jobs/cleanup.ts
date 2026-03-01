import { parentPort } from "node:worker_threads";
import settings from "../data/settings.json" assert { type: "json" };
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

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
