export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 500 | 502,
    message: string,
  ) {
    super(message);
  }
}
