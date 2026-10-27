// Barrel for the GitHub client. The implementation lives in ./githubApi so the
// client's unit test can import the real functions directly.
//
// WHY THE SPLIT: service/controller tests mock.module THIS module to stub the
// client boundary. bun's mock.module is process-global and leaks across files
// on Linux/CI (it resets per-file on macOS, which is why the leak is invisible
// locally). A unit test importing the real impl through this barrel would get a
// leaked stub. Re-registering the real module in afterAll does NOT fix it — the
// override still leaks to later files on Linux (verified failing in CI). The
// only robust fix is a separate module that is never mock.module'd: ./githubApi.
//
// Production code imports from "../clients/github" unchanged.
export * from "./githubApi";
