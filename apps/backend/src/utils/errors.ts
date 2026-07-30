/**
 * Domain-specific error classes.
 *
 * Each subclass carries an explicit HTTP-ish semantic so the HTTP layer can
 * translate to a status code without leaking internals. Never stuff patient
 * data inside `.message` — messages ARE logged and returned to Retell.
 */

export class WebhookValidationError extends Error {
  public readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';
  }
}

export class RetellSignatureError extends Error {
  public readonly httpStatus = 401;
  constructor(message = 'invalid_signature') {
    super(message);
    this.name = 'RetellSignatureError';
  }
}

export class CabinetNotFoundError extends Error {
  constructor(message = 'cabinet_not_found') {
    super(message);
    this.name = 'CabinetNotFoundError';
  }
}
