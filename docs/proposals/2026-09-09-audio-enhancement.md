# Proposal: Pluggable Audio Enhancement Stage

- **Status:** Implemented (2026-09-10) — see "Implementation notes" at the end
  for decisions taken on the open questions and deviations from this draft.
- **Date:** 2026-09-09

## 1. Summary

Turn the current hard-coded `--enhance-audio` ffmpeg chain into a **pluggable enhancer stage** that mirrors the existing backend architecture (`src/backends/`): an enhancer registry, per-enhancer dependency discovery, readiness checks in `doctor`, guided `setup`, and a transparent per-file enhancement report.

Three enhancer engines, tiered by weight:

| Engine | Id | Dependencies | Quality | Status |
| --- | --- | --- | --- | --- |
| FFmpeg built-in filters | `basic` | none (ffmpeg only, already required) | Good — spectral denoise + analysis-driven notch filters | Phase 1 (replaces current chain) |
| DeepFilterNet 3 | `deepfilternet` | optional Python tool install (uv/pipx/pip) or Rust binary | Very good for speech; validated on the cassette corpus | Phase 2 |
| UniSE (HF Space) | `unise` | none local; uploads audio to remote Space | SOTA-potential universal restoration; unstable | Phase 3, experimental |

Every run is **transparent**: the exact ffmpeg filter chain (and model metadata for AI engines) is printed to progress output and included in `--json` results, so a user can always see what was done to their audio and reproduce it manually.

**Enhancement stays strictly opt-in and off by default.** Evidence below shows enhancement can *hurt* ASR accuracy on modern models; the feature is positioned as a rescue path for degraded sources, with an easy A/B workflow.

## 2. Current state

- `--enhance-audio` flag on `transcribe` (boolean) → `config.enableAudioEnhancement` → `enhanceAudio()` in `src/pipeline/audio-enhancer.ts`.
- Current chain is fixed and opaque: `afftdn=nf=-20, acompressor, loudnorm` — one-size-fits-all, no hum analysis, no choice of engine, no dependency story (fine today: ffmpeg only).
- Orchestrator already has an `enhance` pipeline step with progress events (`PipelineStep` includes `"enhance"`), applied after split, before transcription (`src/pipeline/orchestrator.ts` step 3).
- No `doctor` / `setup` / help coverage for enhancement.

## 3. Evidence base

### 3.1 Cassette pipeline (`/mnt/w/projects/audios cassette/new-approach/mejora_audio.py`)

A mature, validated pipeline for family cassette digitizations (11 recordings processed, results in `automatizados/reporte.txt`). Chain per file:

1. **Analysis (numpy, Welch PSD, no extra deps):** mains hum detection — peak bins near 50/60 Hz fundamentals and harmonics vs. 3× local median → `bandreject` notches (`width_type=h`, w=6 fundamental / w=8 harmonics); howl/Larsen detection (dominant tone >500 Hz, <8 kHz, stable ±10 Hz across 10 s blocks in ≥70 % of blocks, >12 dB over floor) → up to 2 notches (w=25).
2. **Conditioning:** optional `adeclick` + `highpass=f=70` + hum notches.
3. **AI denoise:** DeepFilterNet3 @48 kHz (soxr resample round-trip, chunked 600 s inference, optional `atten_lim_db`), or ffmpeg `afftdn=nr=12` fallback for music.
4. **Dynamics:** howl notches + `acompressor=threshold=-25dB:ratio=2.5:attack=10:release=150:makeup=1` + `alimiter=limit=0.97:attack=5:release=100:level=disabled`.
5. **Loudness:** `loudnorm` two-pass linear (I=-16, TP=-1.5, LRA=11) + measured report (LUFS, TP, peak, DC offset).

Real-world results (from `reporte.txt`): all files landed at −16 LUFS ±0.5, peaks ≤ −1.48 dBFS, DC offset ~1e-5; throughput ≈0.08–0.13× realtime on GPU. Notably, **analysis-driven notches beat hardcoded ones**: tapes showed hum at 48.4 Hz and 59.2 Hz (tape-speed flutter off the 50/60 Hz nominal) — a fixed `f=50` notch would have missed both.

Operational lessons that transfer directly:

- **df 0.5.6 + torchaudio ≥2.9 breaks** (`df/io.py` imports removed `torchaudio.backend.common.AudioMetaData`); `mejora_audio.py` carries a runtime shim. Reproduced on the installed venv.
- **Venv console-script shebangs break when a venv is moved** (the local venv's `deepFilter` entrypoint points at its old parent-directory location). Discovery must not rely solely on console scripts; `python -m df.enhance` is the robust fallback.
- **Never modify originals**; write enhanced intermediates to the temp folder; keep them with `--keep-temp`.

### 3.2 Tooling landscape (researched via Tavily, 2026-09-09)

| Option | License / packaging | Fit |
| --- | --- | --- |
| **DeepFilterNet** (RWTH) | MIT. PyPI `deepfilternet` 0.5.6 (latest, 2023); ships `deepFilter` CLI with `--atten-lim`, `-m DeepFilterNet3`, `--pf`, `-o`; model auto-downloads to cache on first use. Also precompiled static Rust binary `deep-filter` (all platforms, embeds DFN2, 48 kHz wav only, no atten limit). | **Recommended AI tier.** CPU real-time capable, GPU optional, proven in cassette work. |
| **UniSE** (arXiv:2510.20441, QuarkAudio) | Apache-2.0 code; no pip package — conda py3.10 + WavLM-Large + BiCodec (Spark-TTS-0.5B) + 0.5 B AR-LM checkpoints; authors state task inference "may exhibit instability"; HF downloads ≈0. Hosted Space (`hugging-apps/unise-speech-enhancement`, 76 likes) runs on ZeroGPU A10G, gradio 6, exposes HTTP API. | **Experimental remote tier only.** Local install is far too heavy/fragile for a CLI extra; remote means uploading audio (privacy) + quota/cold-boot. |
| ffmpeg `afftdn`/`anlmdn`/`adeclick`/`highpass`/`bandreject`/`acompressor`/`alimiter`/`loudnorm` | Built into required ffmpeg. | **Base tier.** Already partially in use. |
| ffmpeg `arnndn` (RNNoise) | Filter built-in, but requires external `.rnnn` model files of unclear licensing. | Rejected for v1 (licensing/distribution); revisit if wanted. |
| `noisereduce` (python, MIT) | pip, no torch; spectral gating. | Rejected — overlaps `afftdn`, no better story for speech. |
| NVIDIA RE-USE / Real-time RE-USE (2026) | "Research and development only" license. | Rejected (license incompatible). |
| VoiceFixer, MP-SENet, FRCRN, etc. | Various; heavier/weaker packaging stories than DFN. | Not shortlisted. |

### 3.3 Enhancement vs. ASR accuracy — why opt-in matters

Systematic studies (e.g. *"When De-noising Hurts"* — arXiv:2512.17562; follow-ups with Whisper) find denoising pre-processing can **degrade** modern ASR WER by ~1.3–3.2 % even on clean-ish input, because enhancement artifacts/distortion hurt more than the removed noise helps. Whisper is already noise-robust.

Consequences for design:

1. Enhancement is **never default**; it is a deliberate user choice per run.
2. Help/docs recommend A/B: transcribe a sample with and without `--enhance` (the standalone `enhance` command makes auditioning cheap).
3. The `asr` profile avoids gratuitous processing (no compressor/loudnorm on the transcription path — Whisper is level-robust; dynamics conditioning is only in the `master` profile for listening/archival outputs).

## 4. Proposed UX

### 4.1 `transcribe`

```bash
# Built-in ffmpeg chain (zero new dependencies) — same as today's --enhance-audio
media-transcriber transcribe in.mp3 --enhance

# Choose the engine (optional value on the same flag)
media-transcriber transcribe ./cassettes ./out --enhance deepfilternet

# Knobs (all optional)
media-transcriber transcribe ./cassettes ./out --enhance deepfilternet --dfn-atten 12
media-transcriber transcribe in.wav --enhance basic --declick --no-hum-notch

# Compatibility: --enhance-audio keeps working, equivalent to --enhance basic
media-transcriber transcribe in.mp3 --enhance-audio
```

New options:

- `--enhance [engine]` — engine: `basic` (default when flag given), `deepfilternet`, `unise`. Optional-value flag.
- `--enhance-audio` — retained as deprecated alias for `--enhance basic` (hidden in help, one-line note).
- `--declick` — add `adeclick` to the conditioning stage (off by default, as in cassette pipeline).
- `--no-hum-notch` — skip hum analysis/notching (analysis runs by default; it's cheap and safe).
- `--dfn-atten <dB>` — DeepFilterNet attenuation limit (`deepFilter --atten-lim`); protects speech in mixed content.
- `--profile asr|master` — post-processing profile (default `asr` in `transcribe`, `master` in `enhance`): `asr` = conditioning + denoise only; `master` = + acompressor + alimiter + 2-pass loudnorm (−16 LUFS).
- `--allow-upload` — required confirmation for any engine that sends audio off-machine (`unise`). Also `MEDIA_TRANSCRIBER_ALLOW_UPLOAD=1`.

Errors: unknown engine → exit 3 (config). Selected engine not installed → exit 2 (missing dependency) with install hint, exactly like backends.

### 4.2 New `enhance` command (audition / standalone use)

```bash
media-transcriber enhance interview.wav                # -> interview_enhanced.wav next to input
media-transcriber enhance ./cassettes ./out --enhance deepfilternet --profile master
media-transcriber enhance in.wav --report              # also writes in_enhancement.json
```

Same engine/profile/knob flags, same doctor-gated dependencies, same report schema. This gives users the "permission and choice" workflow: listen to the enhanced result, then transcribe enhanced or original. It also serves non-transcription use (produce cleaned audio for archival), which is where the cassette-derived `master` profile earns its place.

### 4.3 `doctor`

```bash
media-transcriber doctor                 # adds an "Enhancers" inventory section (non-fatal)
media-transcriber doctor --enhancer deepfilternet   # readiness for one enhancer (fatal if missing)
media-transcriber doctor --all --json
```

- Enhancers display like backends: availability, version, source (`path` / `uv-tool` / `pipx` / `rust-binary`), command resolved, install hint.
- JSON report gains `enhancers: EnhancerReadiness[]` and `selectedEnhancer`.
- Default `doctor` treats enhancers as optional → never fatal unless selected via `--enhancer` (mirrors `--backend` semantics).

### 4.4 `setup`

```bash
media-transcriber setup deepfilternet
```

Guided flow mirroring `setup whisper-local`:

1. Offer install options (filtered by availability): `uv tool install deepfilternet --with torch --with "torchaudio<2.9"` (pin justified by §3.1), pipx equivalent, plain pip in the active env, or "download Rust binary" (fetch platform asset from the v0.5.6 release into `~/.local/bin`, noting it embeds DeepFilterNet2 and lacks `--atten-lim`).
2. Validate via the same discovery chain doctor uses.
3. Optional smoke test: synthesize 2 s of 48 kHz noisy speech-ish tone via ffmpeg (`sine` + `anoisesrc`), run the engine, verify output exists and has expected duration.
4. No secrets stored, no config written — same policy as today.

### 4.5 Help & docs

- Root help examples gain one line: `media-transcriber enhance in.wav --enhance deepfilternet`.
- `transcribe --help` after-text: short table of engines + "run `doctor --enhancer <name>` / `setup <name>`".
- README: new "Audio enhancement" section (engines, profiles, A/B guidance, privacy note for `unise`), `Execution Options` table updated (`enhancer`, `enhanceProfile`, `enhanceOptions` replace `enableAudioEnhancement`).

### 4.6 JSON & progress

- `PipelineStep` already includes `"enhance"`; add `step_progress` events for AI engines (per-chunk percent, sourced from `deepFilter` stderr) so `--json` mode shows enhancement progress like transcription parts.
- `FileResult` gains an optional `enhancement` block (schema below) — present in human output too (one summary line).

## 5. Architecture

### 5.1 Enhancer interface (`src/enhancers/types.ts`, mirrors `TranscriptionBackend`)

```ts
export interface AudioEnhancer {
  readonly name: EnhancerId;            // "basic" | "deepfilternet" | "unise"
  readonly displayName: string;
  readonly requiresUpload: boolean;     // true for unise
  checkAvailability(): Promise<DependencyStatus>;
  /** Enhance one file; returns output path + transparency report. */
  enhance(input: EnhanceRequest): Promise<EnhanceResult>;
  /** Knobs this engine supports, for help/validation. */
  supportedOptions(): EnhancerOption[];
  init(config: Config): void;
}
```

Registry in `src/enhancers/registry.ts` mirroring `src/backends/registry.ts` (`registerBuiltinEnhancers`, `getEnhancer`, `listEnhancers`).

### 5.2 Shared analysis module (no new npm dependencies)

`src/enhancers/analysis.ts` — port of the cassette heuristics:

- Decode ≤5 min mono 16 kHz f32le from ffmpeg via `spawn` pipe (streaming chunks; the hum band needs ≤2 kHz Nyquist, so 16 kHz is plenty and cheap).
- Welch PSD (Hann 2048–8192, 50 % overlap) with a small hand-rolled radix-2 FFT (~60 lines; no dependency).
- `detectHum(psd)` → notch list (fundamental near 50/60 Hz ±2 Hz, harmonics while SNR holds); `detectHowl()` behind a flag (howl notching is risky for music — default off outside cassette-like content).
- Output is deterministic and unit-testable against synthesized fixtures (ffmpeg `sine` at 48.4 Hz + noise).

Engine-independent: every engine gets the same pre-conditioning decision list, so `--enhance basic` and `--enhance deepfilternet` differ only in the denoise step — easy to reason about.

### 5.3 Chain composition (`src/enhancers/chain.ts`)

```
[adeclick?] → highpass=f=70 → [hum notches]      (conditioning, ffmpeg)
→ engine denoise:
     basic:         afftdn=nr=12
     deepfilternet: external process (see 5.4)
     unise:         remote call (see 5.5)
→ [howl notches?]                                 (opt-in, default off)
→ profile master only: acompressor → alimiter → loudnorm (2-pass)
```

The full `-af` string (and engine invocation) is recorded verbatim in the report and progress messages. Enhanced files are intermediates in `config.tempFolder` (kept with `--keep-temp`), except in the standalone `enhance` command where the output file is the product.

`loudnorm` 2-pass implementation: run measurement pass (`-af loudnorm=...:print_format=json -f null -`), parse JSON from stderr (as `mejora_audio.py` does), apply with `measured_*` + `linear=true`; fall back to dynamic mode with a warning if measurement is incomplete.

### 5.4 DeepFilterNet adapter (`src/enhancers/deepfilternet.ts`)

- Discovery (`src/deps/deepfilternet.ts`, mirrors `deps/whisper.ts` order): env override `MEDIA_TRANSCRIBER_DFN_COMMAND` → `deepFilter` on PATH → `uv tool` (`uv tool list`) → pipx → `python -m df.enhance` with discovered python → `deep-filter` (Rust) on PATH as last resort (feature-limited). Validation probe: `--version` (python) / `-V` (rust).
- Wrapping: ffmpeg decode → 48 kHz pcm_s16le wav in temp → `deepFilter <wav> -o <tmp> -m DeepFilterNet3 [--atten-lim N]` → probe duration (integrity: ≥ input − 0.1 s) → continue chain from the wav.
- First run downloads the model into the tool's cache; doctor/setup messages mention this so the cold first call isn't a surprise.
- Known-issue handling: if the probe fails with the torchaudio `AudioMetaData` import error, surface a targeted hint ("reinstall with torchaudio<2.9, or run `media-transcriber setup deepfilternet`") instead of a raw stack.
- Splitting interplay: enhancement runs after split (current step order), so long files hit the engine in ≤ `maxDurationSeconds` chunks — bounded memory, resumable, and consistent with `deepFilter`'s own file-per-call model.

### 5.5 UniSE adapter (`src/enhancers/unise.ts`, Phase 3, experimental)

- Remote via the Space's gradio HTTP API (`/gradio_api/upload` + `/gradio_api/call/...`) using `fetch` — no Python needed.
- Gated: requires `--allow-upload` or env; prints a one-time explicit consent banner ("audio will be uploaded to huggingface.co"); hard cap on input duration (e.g. ≤ `maxDurationSeconds`, ZeroGPU quota reality); clear errors for cold-boot/queue timeouts.
- Doctor checks reachability (HEAD/`api` endpoint), never content; marked "experimental" everywhere it appears.

### 5.6 Report schema (transparency)

`EnhanceResult` (embedded in `FileResult.enhancement`, and written by `enhance --report`):

```jsonc
{
  "engine": "deepfilternet",
  "engineVersion": "0.5.6",
  "command": "deepFilter /tmp/x.wav -o /tmp -m DeepFilterNet3 --atten-lim 12",
  "analysis": { "humNotches": [{"freq": 48.4, "width": 6}], "howlNotches": [] },
  "filterChain": "adeclick,highpass=f=70,bandreject=f=48.4:width_type=h:w=6,...",
  "profile": "asr",
  "loudness": { "beforeLufs": -27.9, "afterLufs": -16.0 },   // master profile only
  "timings": { "analysisMs": 420, "engineMs": 22100, "totalMs": 23400 }
}
```

Mirrors the cassette `reporte.txt` fields that proved useful for QA.

### 5.7 Config schema diff (`src/config/schema.ts`)

```ts
enhancer: z.enum(["none", "basic", "deepfilternet", "unise"]).default("none"),
enhanceProfile: z.enum(["asr", "master"]).default("asr"),
enhanceOptions: z.object({
  declick: z.boolean().default(false),
  humNotch: z.boolean().default(true),
  howlNotch: z.boolean().default(false),
  dfnAttenLimDb: z.number().int().min(0).max(40).optional(),
  loudnessTargetLufs: z.number().min(-30).max(-5).default(-16),
}).default({}),
// enableAudioEnhancement: removed; mapped from --enhance-audio at parse time
```

## 6. Implementation plan

**Phase 1 — architecture + basic engine (ships value alone)**
- Add: `src/enhancers/{types,registry,analysis,chain,basic}.ts`, `src/deps/analysis-fft.ts`, `src/cli/commands/enhance.ts`, tests.
- Modify: `src/cli/commands/transcribe.ts` (flags), `src/config/schema.ts`, `src/pipeline/orchestrator.ts` (call registry instead of `enhanceAudio`; delete `src/pipeline/audio-enhancer.ts`), `doctor.ts`, `setup.ts`, `src/types/index.ts` (`EnhancerId`, report types), README.
- `basic` chain upgrade vs. today: highpass + analysis-driven notches + `afftdn=nr=12` (gentler than `nf=-20`) + optional declick; `master` profile keeps compressor/limiter/2-pass loudnorm.

**Phase 2 — deepfilternet engine**
- Add: `src/enhancers/deepfilternet.ts`, `src/deps/deepfilternet.ts`, setup flow, doctor wiring, `--dfn-atten`.

**Phase 3 — unise (experimental)**
- Add: `src/enhancers/unise.ts`, consent gating, reachability doctor. Feature-flagged in help as `[experimental]`.

## 7. Testing & verification

- **Analysis unit tests (deterministic):** synthesize fixtures with ffmpeg (`sine=frequency=48.4`, `sine=59.2`, `anoisesrc`) → expect exact notch lists; clean speech fixture → expect none. These defend the ported heuristics (fail on plausible regression: bin off-by-one, wrong width).
- **Chain tests:** golden `-af` strings per profile/option combination (contract consumers can replay manually).
- **Enhancer interface:** `basic` end-to-end on a small generated wav in temp (exists/duration/report).
- **dfn adapter:** integration test skipped unless `deepFilter` discoverable (same pattern as whisper tests); mock execa for command construction.
- **CLI:** doctor JSON shape with `enhancers`; transcribe exit 2 when engine missing; `--enhance-audio` alias behavior.
- Manual smoke (documented in PR): cassette sample → `enhance --report`, then transcribe original vs. enhanced, diff WER by ear/spot-check.

## 8. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Enhancement worsens WER on some content | Off by default; A/B workflow; `asr` profile minimal; report shows exactly what ran |
| df 0.5.6 ↔ torchaudio≥2.9 breakage | Setup pins `torchaudio<2.9`; probe error mapped to targeted hint; Rust binary fallback |
| Broken shebangs / moved venvs | Discovery order ends at `python -m df.enhance`; `--version` probe validates before use |
| Remote tier privacy | Explicit `--allow-upload` gate + banner + doctor marks `requiresUpload` |
| UniSE instability (authors' own note), ZeroGPU quota | Phase 3, experimental label, duration cap, hard timeouts |
| Analysis false positives (music with sustained tones) | Hum analysis restricted to 40–90 Hz + harmonics logic; howl default off; `--no-hum-notch` escape hatch |
| Scope creep (video files, stereo preservation) | Chain is audio-only via ffmpeg (`-vn`); channel layout preserved through filter graph; documented |

## 9. Alternatives considered

- **Keep single hard-coded chain** — rejected: no user choice, opaque, already insufficient for cassette-grade sources.
- **ffmpeg `arnndn` (RNNoise)** — rejected for v1: needs externally distributed `.rnnn` models with unclear licensing; `afftdn` + DFN cover the space.
- **Local UniSE install** — rejected: conda + three checkpoint families + 0.5 B LM, authors flag instability; wrong weight class for a CLI extra.
- **Ship a bundled Python helper script (like `mejora_audio.py`) calling the df API** — deferred: the `deepFilter` CLI covers v1 needs (`--atten-lim`, `-m`); an in-process wrapper would only be needed for GPU batch tuning / chunk streaming, which the split stage already approximates.
- **`noisereduce`/RE-USE/VoiceFixer** — rejected: overlap, license, or packaging (see §3.2).

## 10. Open questions

1. **Flag naming:** `--enhance [engine]` + deprecated `--enhance-audio` (proposed) vs. separate `--enhancer <name>` + boolean `--enhance`. Slight preference for the former (one flag, like `--preset`); optional-value flags can surprise in scripts.
2. **Default engine when just `--enhance` is passed:** `basic` (proposed — zero-dependency, never fails) vs. "best available" auto-selection (surprising, doctor-dependent).
3. **Should `transcribe --enhance` keep enhanced audio next to output** (not just temp) for provenance? Proposal: no — `enhance` command is the deliberate path for that; `--keep-temp` preserves intermediates.
4. **Howl detection default:** off outside an explicit `--cassette`/`legacy` preset? Proposing off + `--enhance-options howlNotch=true` for tape workflows.

## References

- Cassette pipeline & results: `/mnt/w/projects/audios cassette/new-approach/mejora_audio.py`, `automatizados/reporte.txt`
- DeepFilterNet: https://github.com/Rikorose/DeepFilterNet · PyPI `deepfilternet` 0.5.6 (MIT) · release v0.5.6 precompiled binaries
- UniSE: arXiv:2510.20441 · https://github.com/alibaba/unified-audio/tree/main/QuarkAudio-UniSE · Space `hugging-apps/unise-speech-enhancement` (ZeroGPU A10G, gradio 6)
- Denoising-hurts literature: arXiv:2512.17562 *"When De-noising Hurts"* (+ `eka-care/when-denoising-hurts`)
- ffmpeg filters: afftdn/anlmdn/adeclick/bandreject/loudnorm/acompressor/alimiter (ffmpeg docs)

## 11. Implementation notes (2026-09-10)

All three phases are implemented and verified end-to-end on this repository.

Decisions on the open questions (§10):

1. **Flag shape:** `--enhance [engine]` as proposed; `--enhance-audio` kept as a
   hidden deprecated alias. The profile flag is `--enhance-profile` (not
   `--profile`) to avoid suggesting it is a transcription-quality preset.
2. **Default engine:** `basic` — never fails, zero new dependencies.
3. **Enhanced audio in transcribe:** intermediates live in the temp folder
   (`--keep-temp` preserves them); the `enhance` command is the deliberate path
   for keeping a product file.
4. **Howl detection:** exposed as `--howl-notch`, off by default (as proposed).

Deviations from the draft, all behavior-preserving or bug-fixing:

- Hum detection picks the **stronger** of the 50/60 Hz candidates instead of
  accepting both independently: at the 16 kHz analysis rate (vs. mejora's
  44.1 kHz) the two search windows sit close enough that spectral leakage from
  a true 60 Hz hum also tripped the 50 Hz test. Mains hum has one fundamental,
  so strongest-wins matches the physical model and the original corpus results.
- The deepFilter probe timeout is 90 s: importing `df` pulls in torch, which
  took 37 s on the WSL-mounted cassette drive (observed), exceeding the 30 s
  the draft implied.
- Howl band upper limit is 7 kHz (draft/orig: <8 kHz) to stay clear of the
  16 kHz analysis Nyquist.

Verified during implementation: unit tests (58 passing, incl. synthetic hum at
48.4/59.2 Hz fixtures), ffmpeg e2e chain tests, CLI smoke for all error paths
(unknown engine → exit 3, missing engine → exit 2, consent gate → exit 3,
doctor `--enhancer` fatality), a real `uv tool`-installed DeepFilterNet 3 run
(`--atten-lim` passthrough, report with verbatim command, −16 LUFS master),
and a full `transcribe --enhance` pipeline run through local Whisper.
