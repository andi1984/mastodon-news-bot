import { parentPort } from "node:worker_threads";

/**
 * Bree worker lifecycle helpers.
 *
 * Two production problems live at the worker/parent boundary:
 *
 * 1. Bree calls `worker.terminate()` the moment a job posts "done". Worker
 *    stdout/stderr travel to the parent asynchronously over an internal
 *    message port, so everything still queued at terminate() time is thrown
 *    away — in practice almost all of a job's log output. `postDone()`
 *    flushes both streams and yields briefly before posting the signal.
 *
 * 2. A worker that never posts "done" sits for the full `closeWorkerAfterMs`
 *    window (300s) holding its complete dependency-graph heap and any live
 *    sockets; overlapping hung workers ratchet the whole-process RSS up.
 *    `startWatchdog()` logs a loud, flushed warning at a soft deadline so the
 *    overrun is attributable to a job in production logs. It deliberately
 *    does NOT post "done" itself: that would make Bree terminate a healthy
 *    slow run wherever it happens to be (e.g. between a URL claim and the
 *    toot that redeems it), which is worse than letting the 300s force-kill
 *    remain the single, well-known backstop.
 */

/** Soft warning deadline for a whole job run — below closeWorkerAfterMs (300s). */
export const WATCHDOG_MS = 240_000;

/** How long postDone waits after flushing so queued stdio reaches the parent. */
const STDIO_DRAIN_MS = 150;

/** Upper bound on waiting for one stream's flush callback. */
const FLUSH_FALLBACK_MS = 500;

// Overridable for tests only — the test runner has no parentPort, so the
// worker-side code paths would otherwise be unreachable under Jest.
let port: { postMessage(value: unknown): void } | null = parentPort;

const flushStream = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => {
    // write() with an empty chunk queues behind all pending output; its
    // callback fires once the stream has handed everything to the transport.
    // Some stream replacements (test runners, exotic stdio) never invoke the
    // callback for an empty chunk — the fallback timer guarantees the flush
    // always completes, so a done signal can never hang on it.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(done, FLUSH_FALLBACK_MS);
    try {
      stream.write("", done);
    } catch {
      done();
    }
  });

/** Flush stdout and stderr so already-written log lines reach the parent. */
export async function flushStdio(): Promise<void> {
  try {
    await flushStream(process.stdout);
    await flushStream(process.stderr);
  } catch {
    // Flushing is best-effort.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let donePosted = false;

/**
 * Signal job completion to Bree (or exit, when run standalone) after flushing
 * stdio, so log lines emitted right before completion actually survive the
 * terminate() that follows. Safe to call more than once; only the first call
 * wins.
 */
export async function postDone(exitCode = 0): Promise<void> {
  if (donePosted) return;
  donePosted = true;

  await flushStdio();
  try {
    await sleep(STDIO_DRAIN_MS);
  } catch {
    // The done signal must go out regardless.
  }

  if (port) port.postMessage("done");
  else process.exit(exitCode);
}

/**
 * Arm a soft per-job deadline. If the job is still running after `ms`, log a
 * loud, flushed warning naming the job — the signal that some await slipped
 * past its documented bound. Bree's closeWorkerAfterMs (300s) remains the
 * only thing that actually kills the worker. The timer is unref'd and cannot
 * keep the worker alive by itself. No-op outside a worker thread so manual
 * `npm run <job>` invocations are unaffected.
 */
export function startWatchdog(jobName: string, ms: number = WATCHDOG_MS): void {
  if (!port) return;

  const timer = setTimeout(() => {
    console.error(
      `[watchdog] ${jobName} still running after ${Math.round(ms / 1000)}s — ` +
        `an await has likely slipped past its bound; Bree will force-kill at closeWorkerAfterMs.`
    );
    // Flush now so this line survives the force-kill that may follow.
    void flushStdio();
  }, ms);
  timer.unref();
}

/** Test hooks: workers get a fresh module per run, tests share one. */
export function _resetForTesting(): void {
  donePosted = false;
}
/**
 * "standalone" forces the no-port (process.exit) path regardless of the
 * environment; null restores the real parentPort. An explicit sentinel so
 * tests don't silently change meaning if the runner ever executes them
 * inside a worker thread.
 */
export function _setPortForTesting(
  fake: { postMessage(value: unknown): void } | "standalone" | null
): void {
  if (fake === "standalone") port = null;
  else port = fake ?? parentPort;
}
