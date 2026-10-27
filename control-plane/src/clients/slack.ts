// Barrel for the Slack client. The implementation lives in ./slackApi so the
// client's unit test can import the real functions directly.
//
// WHY THE SPLIT: service tests mock.module THIS module to stub the client
// boundary. bun's mock.module is process-global and leaks across files on
// Linux/CI (it resets per-file on macOS, which is why the leak is invisible
// locally). A unit test importing the real impl through this barrel would get a
// leaked stub. The only robust fix is a separate module that is never
// mock.module'd: ./slackApi. See control-plane/README.md (Conventions).
//
// Production code imports from "../clients/slack" unchanged.
export * from "./slackApi";
