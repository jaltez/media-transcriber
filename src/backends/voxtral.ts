import { SpeechLmBackend } from "./speech-lm-backend.js";
import { discoverVoxtral, type SpeechLmStatus } from "../deps/speech-lm.js";
import { PROBE_CACHE_KEYS } from "../deps/cache.js";

/**
 * Local Mistral Voxtral backend. Text-only output, so each audio chunk
 * (≤2 min, bounding VRAM and generate() length) becomes one subtitle cue.
 */
export class VoxtralBackend extends SpeechLmBackend {
  readonly name = "voxtral";
  readonly displayName = "Mistral Voxtral (local)";
  readonly defaultModel = "mistralai/Voxtral-Mini-3B-2507";

  protected readonly cacheKey = PROBE_CACHE_KEYS.voxtral;
  protected readonly unavailableMessage =
    "Voxtral runtime is not available. Run 'media-transcriber setup voxtral'.";

  protected discover(): Promise<SpeechLmStatus> {
    return discoverVoxtral();
  }

  supportedModels(): string[] {
    return ["mistralai/Voxtral-Mini-3B-2507"];
  }
}
