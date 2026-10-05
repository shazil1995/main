export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public headers?: Record<string, string>,
  ) { super(message); }
}
export const badRequest = (msg: string, details?: unknown, code = 'bad_request') => new HttpError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string, code = 'conflict', details?: unknown) => new HttpError(409, code, msg, details);
export const unprocessable = (msg: string, details?: unknown, code = 'validation_failed') => new HttpError(422, code, msg, details);
export const versionConflict = (current: unknown) =>
  new HttpError(412, 'version_conflict', 'The record was changed by someone else. Reload and retry.', { current });

/** Error with a message that is safe and useful to show for one cell/field. */
export class ValueError extends Error {}
