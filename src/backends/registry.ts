import type { TranscriptionBackend } from "./types.js";
import { WhisperLocalBackend } from "./whisper-local.js";
import { WhisperApiBackend } from "./whisper-api.js";

const backends = new Map<string, TranscriptionBackend>();

/** Register a backend by name */
export function registerBackend(backend: TranscriptionBackend): void {
  backends.set(backend.name, backend);
}

/** Get a backend by name */
export function getBackend(name: string): TranscriptionBackend | undefined {
  return backends.get(name);
}

/** List all registered backend names */
export function listBackends(): string[] {
  return Array.from(backends.keys());
}

/** Initialize all built-in backends */
export function registerBuiltinBackends(): void {
  registerBackend(new WhisperLocalBackend());
  registerBackend(new WhisperApiBackend());
}
