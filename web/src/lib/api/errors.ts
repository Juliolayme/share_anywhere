/** An error response from the API (docs/API.md §3). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The network could not be reached (offline, DNS, connection refused). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('network unavailable', { cause });
    this.name = 'NetworkError';
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: string; message?: string; retry_after_s?: number } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON body */
  }
  const header = Number(res.headers.get('Retry-After'));
  const retry = body.retry_after_s ?? (Number.isFinite(header) && header > 0 ? header : undefined);
  return new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? res.statusText, retry, body);
}
