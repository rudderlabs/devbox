export const API_BODY_LIMIT_BYTES = 256 * 1024;
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

// Bun rejects Content-Length requests before routing and does not use the
// route's JSON error shape. Keep its process-wide safety backstop above every
// route limit so route middleware owns the documented 413 response.
export const MAX_REQUEST_BODY_SIZE_BYTES =
  2 * Math.max(API_BODY_LIMIT_BYTES, WEBHOOK_BODY_LIMIT_BYTES);
