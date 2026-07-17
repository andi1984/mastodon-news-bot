import { createRestAPIClient } from "masto";

// Without an explicit timeout masto applies none at all, so a stalled
// Mastodon connection is only cut by undici's 300s headers timeout — the
// same instant Bree force-kills the worker. Keep every API call well below
// that window; jobs already tolerate masto errors.
const REQUEST_TIMEOUT_MS = 30_000;

const getInstance = async () => {
  return await createRestAPIClient({
    url: process.env.API_INSTANCE as string,
    accessToken: process.env.ACCESS_TOKEN as string,
    timeout: REQUEST_TIMEOUT_MS,
  });
};

export default getInstance;
