import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import type { DependencyStatus } from "../types/index.js";
import type { AudioEnhancer, DenoiseRequest, DenoiseResult } from "./types.js";

/**
 * EXPERIMENTAL remote engine: UniSE (arXiv:2510.20441) served by the public
 * Hugging Face Space hugging-apps/unise-speech-enhancement (ZeroGPU A10G,
 * gradio 6). The authors note that task inference "may exhibit instability".
 *
 * No local dependencies, but the audio is UPLOADED to the Space — every code
 * path gates on explicit user consent (allowUpload), and the Space can be
 * asleep (slow cold boot) or quota-limited (ZeroGPU), which surfaces as
 * clear errors rather than hangs. The gradio endpoint is discovered at
 * runtime from /gradio_api/info so minor Space changes do not require a
 * media-transcriber release.
 */

const SPACE_URL = "https://hugging-apps-unise-speech-enhancement.hf.space";
const INFO_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const JOB_TIMEOUT_MS = 15 * 60_000;

const UNAVAILABLE_HINT =
  "UniSE is a remote Hugging Face Space. Check your network connection and " +
  "https://huggingface.co/spaces/hugging-apps/unise-speech-enhancement (the Space may be sleeping or rate-limited).";

interface GradioEndpointInfo {
  endpoint: string;
  /** Ordered parameter names of the selected endpoint */
  parameters: string[];
}

/** Score a gradio /info parameter description for audio/file inputs. */
function looksLikeAudioParam(param: unknown): boolean {
  const text = JSON.stringify(param ?? "").toLowerCase();
  return text.includes("audio") || text.includes("filepath") || text.includes("filedata");
}

function selectGradioEndpoint(info: unknown): GradioEndpointInfo | null {
  if (!info || typeof info !== "object") return null;
  const named = (info as Record<string, unknown>)["named_endpoints"];
  if (!named || typeof named !== "object") return null;

  let fallback: GradioEndpointInfo | null = null;
  for (const [endpoint, detail] of Object.entries(named as Record<string, unknown>)) {
    const parameters = (detail as Record<string, unknown>)["parameters"];
    if (!Array.isArray(parameters)) continue;
    const names = parameters.map((p) => String((p as Record<string, unknown>)["parameter_name"] ?? ""));
    const entry: GradioEndpointInfo = { endpoint, parameters: names };
    if (!fallback) fallback = entry;
    const audioParams = parameters.filter(looksLikeAudioParam).length;
    if (audioParams >= 1 && parameters.length <= 3) {
      return entry;
    }
  }
  return fallback;
}

export class UniseEnhancer implements AudioEnhancer {
  readonly name = "unise" as const;
  readonly displayName = "UniSE (remote, experimental)";
  readonly experimental = true;
  readonly requiresUpload = true;

  init(_config: Config): void {
    // Stateless engine; nothing to configure.
  }

  async checkAvailability(): Promise<DependencyStatus> {
    try {
      const response = await fetch(`${SPACE_URL}/gradio_api/info`, {
        signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
      });
      if (response.ok) {
        return {
          available: true,
          name: this.name,
          version: "remote (gradio Space)",
          source: "remote",
          command: SPACE_URL,
        };
      }
      return {
        available: false,
        name: this.name,
        error: `Space responded with HTTP ${response.status}`,
        installHint: UNAVAILABLE_HINT,
        source: "remote",
        command: SPACE_URL,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        name: this.name,
        error: `Space unreachable: ${message}`,
        installHint: UNAVAILABLE_HINT,
        source: "remote",
        command: SPACE_URL,
      };
    }
  }

  async denoise(request: DenoiseRequest): Promise<DenoiseResult> {
    if (!request.allowUpload) {
      throw new Error(
        "UniSE runs on a remote Hugging Face Space and uploads your audio. " +
        "Pass --allow-upload (or set MEDIA_TRANSCRIBER_ALLOW_UPLOAD=1) to consent.",
      );
    }

    const infoResponse = await fetch(`${SPACE_URL}/gradio_api/info`, {
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!infoResponse.ok) {
      throw new Error(`UniSE Space info request failed (HTTP ${infoResponse.status}). ${UNAVAILABLE_HINT}`);
    }
    const endpoint = selectGradioEndpoint(await infoResponse.json());
    if (!endpoint) {
      throw new Error("Could not find an enhancement endpoint in the UniSE Space API. The Space layout may have changed.");
    }

    // Upload the conditioned WAV.
    const bytes = await readFile(request.inputFile);
    const form = new FormData();
    form.append("files", new Blob([bytes]), "input.wav");
    request.onProgress?.(10, "uploading to UniSE Space");
    const uploadResponse = await fetch(`${SPACE_URL}/gradio_api/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!uploadResponse.ok) {
      throw new Error(`UniSE upload failed (HTTP ${uploadResponse.status}). ${UNAVAILABLE_HINT}`);
    }
    const uploadedPaths = (await uploadResponse.json()) as string[];
    if (!Array.isArray(uploadedPaths) || uploadedPaths.length === 0) {
      throw new Error("UniSE upload returned no file handle");
    }

    // Kick off the job.
    const callResponse = await fetch(`${SPACE_URL}/gradio_api/call/${endpoint.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [uploadedPaths[0]] }),
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!callResponse.ok) {
      throw new Error(`UniSE job submission failed (HTTP ${callResponse.status}).`);
    }
    const { event_id: eventId } = (await callResponse.json()) as { event_id?: string };
    if (!eventId) {
      throw new Error("UniSE job submission returned no event id");
    }
    request.onProgress?.(30, "queued on UniSE Space (ZeroGPU)");

    // Stream job events until complete/error.
    const data = await this.waitForCompletion(endpoint.endpoint, eventId, request);
    const url = this.extractResultUrl(data);
    if (!url) {
      throw new Error("UniSE returned no audio output. The Space may have rejected the input.");
    }
    const absolute = url.startsWith("http") ? url : `${SPACE_URL}${url}`;

    request.onProgress?.(85, "downloading result");
    const downloadResponse = await fetch(absolute, {
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!downloadResponse.ok) {
      throw new Error(`UniSE result download failed (HTTP ${downloadResponse.status})`);
    }

    await mkdir(request.tempFolder, { recursive: true });
    const outputFile = join(request.tempFolder, "unise_enhanced.wav");
    await writeFile(outputFile, Buffer.from(await downloadResponse.arrayBuffer()));

    return {
      outputFile,
      engineVersion: "remote (gradio Space)",
      command: `${SPACE_URL} ${endpoint.endpoint} [uploaded input.wav]`,
    };
  }

  private async waitForCompletion(
    endpoint: string,
    eventId: string,
    request: DenoiseRequest,
  ): Promise<unknown> {
    const response = await fetch(
      `${SPACE_URL}/gradio_api/call/${endpoint}/${eventId}`,
      { signal: AbortSignal.timeout(JOB_TIMEOUT_MS) },
    );
    if (!response.ok || !response.body) {
      throw new Error(`UniSE event stream failed (HTTP ${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");

        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (currentEvent === "error") {
              throw new Error(`UniSE Space reported an error: ${payload}`);
            }
            if (currentEvent === "complete") {
              try {
                return JSON.parse(payload);
              } catch {
                throw new Error("UniSE Space returned malformed completion data");
              }
            }
          }
        }
      }
      request.onProgress?.(50, "waiting for UniSE result");
    }
    throw new Error("UniSE event stream ended without a completion event");
  }

  private extractResultUrl(data: unknown): string | null {
    const visit = (value: unknown): string | null => {
      if (typeof value === "string") {
        return value.endsWith(".wav") || value.endsWith(".mp3") ? value : null;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item);
          if (found) return found;
        }
        return null;
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record["url"] === "string") return record["url"];
        if (typeof record["path"] === "string") return record["path"];
        for (const item of Object.values(record)) {
          const found = visit(item);
          if (found) return found;
        }
      }
      return null;
    };
    return visit(data);
  }
}
