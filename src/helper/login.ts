import { createRestAPIClient } from "masto";

// Without an explicit timeout masto applies none at all, so a stalled
// Mastodon connection is only cut by undici's 300s headers timeout — the
// same instant Bree force-kills the worker. Keep every API call well below
// that window; jobs already tolerate masto errors.
//
// NOTE: masto implements this option via AbortSignal.timeout on every
// request, and media uploads are FormData+Blob POSTs — exactly the shape
// that leaks retained bodies per abort on Node 24.16–24.17 (nodejs/node
// #63708). That is why .nvmrc pins 24.15.0; re-verify with the churn test in
// docs/operations.md before moving the pin.
const REQUEST_TIMEOUT_MS = 30_000;

const getInstance = async () => {
  return await createRestAPIClient({
    url: process.env.API_INSTANCE as string,
    accessToken: process.env.ACCESS_TOKEN as string,
    timeout: REQUEST_TIMEOUT_MS,
  });
};

export default getInstance;
