// Every error a user sees names the layer that failed and the next command.
export type Layer = "ledger" | "ACP runtime" | "agent" | "verifier" | "git" | "config";

export class FoundryError extends Error {
  constructor(
    readonly layer: Layer,
    message: string,
    readonly next: string,
  ) {
    super(message);
  }

  format(): string {
    return `error [${this.layer}]: ${this.message}\n  next: ${this.next}`;
  }
}
