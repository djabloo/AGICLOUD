export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}
