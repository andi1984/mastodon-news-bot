import { jest } from "@jest/globals";
import {
  postDone,
  startWatchdog,
  WATCHDOG_MS,
  _resetForTesting,
  _setPortForTesting,
} from "./workerLifecycle.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("workerLifecycle", () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    _resetForTesting();
    _setPortForTesting("standalone");
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    _setPortForTesting(null);
    exitSpy.mockRestore();
  });

  describe("standalone (no parentPort)", () => {
    test("postDone exits with the given code", async () => {
      await postDone(0);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("postDone passes a non-zero exit code through", async () => {
      await postDone(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test("startWatchdog is a no-op", async () => {
      startWatchdog("test-job", 20);
      await sleep(100);
      // No port and no exit: the watchdog must not have done anything.
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("worker path (injected port)", () => {
    let posted: unknown[];
    const fakePort = { postMessage: (v: unknown) => posted.push(v) };

    beforeEach(() => {
      posted = [];
      _setPortForTesting(fakePort);
    });

    test("postDone posts the Bree done signal instead of exiting", async () => {
      await postDone();
      expect(posted).toEqual(["done"]);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    test("postDone only signals once even when called repeatedly", async () => {
      await postDone();
      await postDone();
      await postDone(1);
      expect(posted).toEqual(["done"]);
    });

    test("postDone flushes stdout and stderr before signalling", async () => {
      // Record how many done signals had been posted at flush time — the
      // flush must strictly precede the postMessage("done").
      const postedAtFlushTime: number[] = [];
      const recordingImpl = ((
        _chunk: unknown,
        encodingOrCb?: unknown,
        cb?: unknown
      ) => {
        postedAtFlushTime.push(posted.length);
        const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
        if (typeof callback === "function") (callback as () => void)();
        return true;
      }) as typeof process.stdout.write;
      const stdoutWrite = jest
        .spyOn(process.stdout, "write")
        .mockImplementation(recordingImpl);
      const stderrWrite = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(recordingImpl);

      await postDone();

      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();

      expect(postedAtFlushTime.length).toBeGreaterThanOrEqual(2);
      expect(postedAtFlushTime.every((n) => n === 0)).toBe(true);
      expect(posted).toEqual(["done"]);
    });

    test("watchdog warns but never posts done — the job decides completion", async () => {
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      startWatchdog("slow-job", 20);
      await sleep(800); // > 20ms deadline + 500ms flush fallback

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[watchdog] slow-job")
      );
      expect(posted).toEqual([]);

      errorSpy.mockRestore();
    });
  });

  test("watchdog deadline stays below Bree's 300s closeWorkerAfterMs", () => {
    // src/index.ts kills any worker at 300_000ms; the watchdog must warn first.
    expect(WATCHDOG_MS).toBeLessThan(300_000);
  });
});
