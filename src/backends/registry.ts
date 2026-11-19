import type { TranscriptionBackend } from "./types.js";
import { WhisperLocalBackend } from "./whisper-local.js";
import { WhisperApiBackend } from "./whisper-api.js";
import { ParakeetBackend } from "./parakeet.js";
import { FasterWhisperBackend } from "./faster-whisper.js";
import { WhisperCppBackend } from "./whisper-cpp.js";
import { GraniteBackend } from "./granite.js";
import { VoxtralBackend } from "./voxtral.js";

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
  registerBackend(new FasterWhisperBackend());
  registerBackend(new WhisperCppBackend());
  registerBackend(new ParakeetBackend());
  registerBackend(new GraniteBackend());
  registerBackend(new VoxtralBackend());
  registerBackend(new WhisperApiBackend());
}
