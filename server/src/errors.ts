/** An error that is safe to show to the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (message = "Sign in to continue.") => new AppError(401, "unauthenticated", message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found.`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unprocessable = (code: string, message: string) => new AppError(422, code, message);
export const locked = (message: string) => new AppError(423, "locked", message);
