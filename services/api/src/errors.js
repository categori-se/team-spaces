// @ts-check

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} title
   * @param {string} [detail]
   */
  constructor(status, title, detail = title) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

export class ConflictError extends HttpError {
  constructor(detail = "The submitted version is stale") {
    super(409, "Conflict", detail);
  }
}

export class ForbiddenError extends HttpError {
  constructor(detail = "You do not have permission to perform this action") {
    super(403, "Forbidden", detail);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(detail = "Authentication is required") {
    super(401, "Unauthorized", detail);
  }
}

export class NotFoundError extends HttpError {
  constructor(detail = "The requested resource was not found") {
    super(404, "Not Found", detail);
  }
}

export class ValidationError extends HttpError {
  constructor(detail = "The request is invalid") {
    super(400, "Bad Request", detail);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(detail = "The request body is too large") {
    super(413, "Payload Too Large", detail);
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(detail = "The request limit has been reached") {
    super(429, "Too Many Requests", detail);
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(detail = "The service is temporarily unavailable") {
    super(503, "Service Unavailable", detail);
  }
}
