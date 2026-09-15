/**
 * Typed errors. Each error carries a stable `code` and a process `exitCode`:
 *
 *   2  usage / argument error
 *   3  config or authentication error
 *   4  Feedly API / network error
 */
export class FeedlyError extends Error {
    constructor(message, { code = 'E_FEEDLY', exitCode = 1, hint = '' } = {}) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.exitCode = exitCode;
        this.hint = hint;
    }
}

export class ArgumentError extends FeedlyError {
    constructor(message, hint = '') {
        super(message, { code: 'E_USAGE', exitCode: 2, hint });
    }
}

export class ConfigError extends FeedlyError {
    constructor(message, hint = '') {
        super(message, { code: 'E_CONFIG', exitCode: 3, hint });
    }
}

export class AuthError extends FeedlyError {
    constructor(message, hint = '') {
        super(message, { code: 'E_AUTH', exitCode: 3, hint });
    }
}

export class ApiError extends FeedlyError {
    constructor(message, { hint = '', status = 0 } = {}) {
        super(message, { code: 'E_API', exitCode: 4, hint });
        this.status = status;
    }
}

export function isFeedlyError(value) {
    return value instanceof FeedlyError;
}
