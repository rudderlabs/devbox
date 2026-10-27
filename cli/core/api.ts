// HTTP transport for the CP API: one method per endpoint and nothing else;
// the operations in tasks.ts, account.ts and events.ts build on it. Errors
// become ApiFailure, with `status` null when the API can't be reached. The token
// goes only into the Authorization header, never into a message.
import type {
  ApiErrorBody,
  ApiTask,
  ApiTaskSource,
  ApiTaskState,
  CreateTaskRequest,
  ListEventsResponse,
  ListTasksResponse,
  MeResponse,
  RestartTaskRequest,
  SendMessageRequest,
  SendMessageResponse,
} from "../../control-plane/src/types/api";

export class ApiFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// 4xx answers, including 401, 404 and 409, won't change on retry. Nor will an
// answer that isn't the API's (e.g. an SSO login page).
export const isFatal = (err: unknown): boolean =>
  err instanceof ApiFailure &&
  (err.code === "invalid_response" ||
    (err.status !== null && err.status >= 400 && err.status < 500));

export type ClientConfig = { url: string; token?: string };

export type ListTasksQuery = {
  source?: ApiTaskSource;
  created_by?: string;
  state?: ApiTaskState;
  limit: number;
  before?: string;
};

const taskPath = (ref: string) => `/api/tasks/${encodeURIComponent(ref)}`;

export class ApiClient {
  constructor(
    private readonly config: ClientConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  me(): Promise<MeResponse> {
    return this.json("GET", "/api/me");
  }

  createTask(body: CreateTaskRequest): Promise<ApiTask> {
    return this.json("POST", "/api/tasks", body);
  }

  listTasks(q: ListTasksQuery): Promise<ListTasksResponse> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    return this.json("GET", `/api/tasks?${params}`);
  }

  getTask(ref: string): Promise<ApiTask> {
    return this.json("GET", taskPath(ref));
  }

  sendMessage(ref: string, body: SendMessageRequest): Promise<SendMessageResponse> {
    return this.json("POST", `${taskPath(ref)}/messages`, body);
  }

  restartTask(ref: string, body: RestartTaskRequest): Promise<ApiTask> {
    return this.json("POST", `${taskPath(ref)}/restart`, body);
  }

  // `signal` also aborts reading the body.
  listEvents(
    ref: string,
    after: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ListEventsResponse> {
    return this.json(
      "GET",
      `${taskPath(ref)}/events?after=${after}&limit=${limit}`,
      undefined,
      signal,
    );
  }

  async openStream(
    ref: string,
    lastEventId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
    const res = await this.send(
      "GET",
      `${taskPath(ref)}/events/stream`,
      undefined,
      headers,
      signal,
    );
    if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw this.invalid(res, "not an event stream");
    }
    if (!res.body) throw new ApiFailure(null, "unreachable", "the event stream has no body");
    return res.body;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.send(method, path, body, {}, signal);
    try {
      return (await res.json()) as T;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw this.invalid(res, "not JSON");
    }
  }

  // A 2xx answer that isn't the API's. Only the URL goes into the message.
  private invalid(res: Response, what: string): ApiFailure {
    return new ApiFailure(
      res.status,
      "invalid_response",
      `unexpected response from ${this.config.url}: ${what}`,
    );
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const all = { ...headers };
    if (this.config.token) all.authorization = `Bearer ${this.config.token}`;
    if (body !== undefined) all["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.url}${path}`, {
        method,
        headers: all,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiFailure(
        null,
        "unreachable",
        `cannot reach ${this.config.url}: ${(err as Error).message}`,
      );
    }
    if (!res.ok) throw await this.failure(res);
    return res;
  }

  private async failure(res: Response): Promise<ApiFailure> {
    const text = await res.text();
    try {
      const { error } = JSON.parse(text) as Partial<ApiErrorBody>;
      if (error?.code) {
        return new ApiFailure(
          res.status,
          error.code,
          `${error.message} (${res.status} ${error.code})`,
        );
      }
    } catch {
      // Not an API error body (e.g. the ALB's HTML page).
    }
    return new ApiFailure(
      res.status,
      `http_${res.status}`,
      `HTTP ${res.status} from ${this.config.url}`,
    );
  }
}
