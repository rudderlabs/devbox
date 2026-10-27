// Account operations: who the API says the token is.
import type { MeResponse } from "../../control-plane/src/types/api";
import type { ApiClient } from "./api";

export function whoami(api: ApiClient): Promise<MeResponse> {
  return api.me();
}
