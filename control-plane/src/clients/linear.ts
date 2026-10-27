// Barrel for the Linear client. The implementation lives in ./linearApi so the
// client's unit test can import the real functions directly.
//
// WHY THE SPLIT: service/controller tests mock.module THIS module to stub the
// client boundary. bun's mock.module is process-global and leaks across files on
// Linux/CI. A unit test importing the real impl through this barrel would get a
// leaked stub. Keep the implementation behind a specifier tests never mock.
//
// Production code imports from "../clients/linear" unchanged.
export * from "./linearApi";
