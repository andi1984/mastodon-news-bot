const { parentPort } = require("worker_threads");
import settings from "../data/settings.json";
import createClient from "../helper/db";

// Create a single supabase client for interacting with your database
const supabase = createClient();

(async () => {
  const { data, error } = await supabase
    .from(settings.db_table)
    .delete()
    .eq("tooted", true)
    .select();

  console.log(`Deleted ${data?.length} entries`);

  if (!!error) {
    console.error(error.message);
  }

  // Optional filter for feed items within certain freshness interval (hours)
  if (!!settings.min_freshness_hours) {
    // https://github.com/supabase/supabase/discussions/3734#discussioncomment-1579562
    const minFreshnessDate = new Date();
    minFreshnessDate.setHours(
      minFreshnessDate.getHours() - settings.min_freshness_hours
    );

    console.log(`Cleaning up items older than ${minFreshnessDate}.`);
    const { data: freshnessDataPubDate, error: freshnessErrorPubDate } =
      await supabase
        .from(settings.db_table)
        .delete()
        .filter("pub_date", "lte", minFreshnessDate.toISOString())
        .eq("tooted", false)
        .select();

    console.log(`Cleaned up ${freshnessDataPubDate?.length} stale feed items.`);

    console.log(`Cleaning up items older than ${minFreshnessDate}.`);
    const { data: freshnessData, error: freshnessError } = await supabase
      .from(settings.db_table)
      .delete()
      .filter("created_at", "lte", minFreshnessDate.toISOString())
      .eq("tooted", false)
      .select();

    console.log(`Cleaned up ${freshnessData?.length} stale feed items.`);
  }

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
