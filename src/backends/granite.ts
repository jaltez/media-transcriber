import { SpeechLmBackend } from "./speech-lm-backend.js";
import { discoverGranite, type SpeechLmStatus } from "../deps/speech-lm.js";
import { PROBE_CACHE_KEYS } from "../deps/cache.js";

/**
 * Local IBM Granite Speech backend. Text-only output, so each audio chunk
 * (≤2 min, the model card's segment limit) becomes one subtitle cue.
 */
export class GraniteBackend extends SpeechLmBackend {
  readonly name = "granite";
  readonly displayName = "IBM Granite Speech (local)";
  readonly defaultModel = "ibm-granite/granite-speech-5.0-2b";

  protected readonly cacheKey = PROBE_CACHE_KEYS.granite;
  protected readonly unavailableMessage =
    "Granite Speech runtime is not available. Run 'media-transcriber setup granite'.";

  protected discover(): Promise<SpeechLmStatus> {
    return discoverGranite();
  }

  supportedModels(): string[] {
    return ["ibm-granite/granite-speech-5.0-2b", "ibm-granite/granite-speech-4.1-2b"];
  }
}
