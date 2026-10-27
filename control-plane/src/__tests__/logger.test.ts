import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  setSystemTime,
  spyOn,
} from "bun:test";
// Import the implementation, not the `../logger` barrel, so a test file that
// mock.modules the barrel (none does today; such mocks leak into later files
// on Linux) cannot replace the logger under test.
import { logger, setup } from "../winstonLogger";

const NOW = "2026-10-13T12:00:00.000Z";

describe("logger", () => {
  let write: Mock<typeof process.stdout.write>;

  beforeEach(() => {
    setSystemTime(new Date(NOW));
    write = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
    setSystemTime();
  });

  function records(): unknown[] {
    return write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
  }

  it("redacts nested keys that match the default patterns", () => {
    setup("svc", {});
    logger.info("hello", { auth: { token: "x" }, ok: 1 });
    expect(records()).toEqual([
      {
        level: "info",
        message: "hello",
        service: "svc",
        auth: { token: "[REDACTED]" },
        ok: 1,
        timestamp: NOW,
      },
    ]);
  });

  it("logs an Error's message and carries its stack", () => {
    setup("svc", {});
    const err = new Error("boom");
    logger.error(err);
    expect(records()).toEqual([
      { level: "error", message: "boom", service: "svc", stack: err.stack, timestamp: NOW },
    ]);
  });

  it("merges setup() metadata into every record", () => {
    setup("svc", { podId: "pod-1" });
    logger.warn("careful", { attempt: 2 });
    expect(records()).toEqual([
      {
        level: "warn",
        message: "careful",
        service: "svc",
        podId: "pod-1",
        attempt: 2,
        timestamp: NOW,
      },
    ]);
  });

  it("uses the redacted keys passed to setup(), matching strings case-insensitively", () => {
    setup("svc", {}, ["apiKey"]);
    try {
      logger.info({ APIKEY: "k", token: "t" }, { apikey: "k2" });
    } finally {
      // Redacted keys persist in the module; restore the production list.
      setup("svc", {}, [/token/i, /secret/i, /password/i, /authorization/i]);
    }
    expect(records()).toEqual([
      {
        level: "info",
        message: JSON.stringify({ APIKEY: "[REDACTED]", token: "t" }),
        service: "svc",
        apikey: "[REDACTED]",
        timestamp: NOW,
      },
    ]);
  });
});
