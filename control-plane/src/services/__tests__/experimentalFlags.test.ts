import { describe, expect, it } from "bun:test";
import {
  experimentalEnvName,
  extractExperimentalFlags,
  parseExperimentalFlags,
} from "../experimentalFlags";

describe("experimentalFlags", () => {
  describe("parseExperimentalFlags", () => {
    it("parses a single flag and strips the control token", () => {
      expect(parseExperimentalFlags("Run this\n\n#devbox:exp:FAST_PATH")).toEqual({
        flags: ["FAST_PATH"],
        strippedDescription: "Run this\n\n",
      });
    });

    it("deduplicates multiple flags while preserving first-seen order", () => {
      expect(
        parseExperimentalFlags("#devbox:exp:ONE body #devbox:exp:TWO\n#devbox:exp:ONE"),
      ).toEqual({
        flags: ["ONE", "TWO"],
        strippedDescription: " body \n",
      });
    });

    it("rejects malformed names and leaves them in the prompt", () => {
      expect(
        parseExperimentalFlags(
          [
            "#devbox:exp:lowercase",
            "#devbox:exp:PATH=/tmp",
            "#devbox:exp:BAD-NAME",
            "#devbox:exp:1BAD",
            "keep",
          ].join("\n"),
        ),
      ).toEqual({
        flags: [],
        strippedDescription: [
          "#devbox:exp:lowercase",
          "#devbox:exp:PATH=/tmp",
          "#devbox:exp:BAD-NAME",
          "#devbox:exp:1BAD",
          "keep",
        ].join("\n"),
      });
    });

    it("recognizes flags followed by prose punctuation and preserves the punctuation", () => {
      expect(
        parseExperimentalFlags("Enable #devbox:exp:FAST_PATH. Then #devbox:exp:TRACE2, test"),
      ).toEqual({
        flags: ["FAST_PATH", "TRACE2"],
        strippedDescription: "Enable . Then , test",
      });
    });

    it("recognizes tokens only at start of string or after whitespace", () => {
      expect(parseExperimentalFlags("email#devbox:exp:FAST #devbox:exp:OK")).toEqual({
        flags: ["OK"],
        strippedDescription: "email#devbox:exp:FAST ",
      });
    });

    it("preserves whitespace and blank lines after stripping", () => {
      expect(
        parseExperimentalFlags("first  \n#devbox:exp:ONE\n\n\nsecond #devbox:exp:TWO  "),
      ).toEqual({
        flags: ["ONE", "TWO"],
        strippedDescription: "first  \n\n\n\nsecond   ",
      });
    });

    it("passes through descriptions without tokens unchanged", () => {
      expect(parseExperimentalFlags("first  \n\n\nsecond  ")).toEqual({
        flags: [],
        strippedDescription: "first  \n\n\nsecond  ",
      });
    });
  });

  it("rejects service-link-shaped names before creating sandbox env", () => {
    for (const flag of ["PORT", "SERVICE_HOST", "PORT_53_UDP"]) {
      expect(experimentalEnvName(flag)).toBeNull();
    }
    expect(
      extractExperimentalFlags({
        experimentalFlags: ["FAST_PATH", "PORT", "SERVICE_HOST", "PORT_53_UDP"],
      }),
    ).toEqual(["FAST_PATH"]);
    expect(
      parseExperimentalFlags("#devbox:exp:PORT #devbox:exp:SERVICE_HOST #devbox:exp:OK"),
    ).toEqual({
      flags: ["OK"],
      strippedDescription: "  ",
    });
  });

  describe("extractExperimentalFlags", () => {
    it("defensively extracts sanitized unique flag names from metadata", () => {
      expect(
        extractExperimentalFlags({
          experimentalFlags: ["ONE", "lower", "TWO", "ONE", "PATH=/tmp"],
        }),
      ).toEqual(["ONE", "TWO"]);
    });
  });
});
