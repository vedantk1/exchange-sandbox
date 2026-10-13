export class CommandConflictError extends Error {
  readonly code = 'COMMAND_CONFLICT';
  constructor() {
    super('This command ID is already bound to a different payload.');
    this.name = 'CommandConflictError';
  }
}

export class RecoveryError extends Error {
  readonly code = 'RECOVERY_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

export class WriterUnavailableError extends Error {
  readonly code = 'WRITER_UNAVAILABLE';
  constructor() {
    super('The exchange writer is unavailable or another instance owns it.');
    this.name = 'WriterUnavailableError';
  }
}
