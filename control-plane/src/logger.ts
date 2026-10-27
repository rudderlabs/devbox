// Barrel for the logger. Production code imports this specifier, and tests that
// stub the logger mock.module it. The implementation lives in ./winstonLogger,
// which is never mocked, so its own tests stay unaffected by a leaked mock.
export { logger, setup } from "./winstonLogger";
