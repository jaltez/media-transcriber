import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  Renderable,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  DEFAULT_ENHANCE_FORM,
  DEFAULT_TRANSCRIBE_FORM,
  buildDoctorArgs,
  buildEnhanceArgs,
  buildTranscribeArgs,
  describeProgressEvent,
  parseProgressLine,
  type EnhanceForm,
  type TranscribeForm,
} from "./pure/args.js";
import { fuzzyFilter } from "./pure/fuzzy.js";
import { parsePastedPaths } from "./pure/paste-paths.js";
import {
  buildQueue,
  displayName,
  formatBytes,
  scanMediaFiles,
  selectAll,
  selectedPaths,
  toggleAt,
  type QueueItem,
} from "./pure/queue.js";

/**
 * media-transcriber TUI (@opentui/core, imperative renderables).
 *
 * Layout: header + mode tabs / [file queue | main view] / keybind footer,
 * with overlays for help, quit confirmation, text entry, and the enhancement
 * report viewer. All work is delegated to the CLI itself, spawned as a child
 * process in --json mode (single code path, identical behavior).
 */

const THEME = {
  fg: "#c8cdd3",
  dim: "#6f7882",
  accent: "#56b6c2",
  ok: "#98c379",
  warn: "#e5c07b",
  err: "#e06c75",
  border: "#4b5263",
  selectedBg: "#2c313a",
};

function col(hex: string): RGBA {
  return RGBA.fromHex(hex);
}

const MODES = ["Transcribe", "Enhance", "Doctor"] as const;
type Mode = (typeof MODES)[number];

const BACKENDS = ["whisper-local", "whisper-api", "parakeet"] as const;
const PRESETS = ["(off)", "fast", "balanced", "accurate"] as const;
const FORMATS = ["txt,srt", "txt", "srt"] as const;
const ENHANCERS = ["none", "basic", "deepfilternet", "unise"] as const;
const ENHANCE_PROFILE = ["asr", "master"] as const;
const ENHANCE_ENGINES = ["basic", "deepfilternet", "unise"] as const;

const STATUS_GLYPH: Record<QueueItem["status"], { glyph: string; color: string }> = {
  pending: { glyph: "·", color: THEME.dim },
  running: { glyph: "▶", color: THEME.accent },
  done: { glyph: "✓", color: THEME.ok },
  failed: { glyph: "✗", color: THEME.err },
};

const HELP_TEXT = [
  "media-transcriber TUI — keys",
  "",
  "  tab        cycle focus (files → form → modes)",
  "  1 / 2 / 3  switch Transcribe / Enhance / Doctor",
  "  up / down  move in list or form",
  "  space      toggle file selection      a  select all / none",
  "  ← / →      change the focused form value",
  "  return     edit a text field (model, output dir, split)",
  "  esc        close overlay / leave a field",
  "  r          run on selected files      g  rescan root",
  "  d          change scan directory      p  stage from clipboard",
  "  o          open output in system app  v  view enhancement report",
  "  ctrl+r     run (works while typing in the filter)",
  "  paste      dropped/pasted paths are staged automatically",
  "  ?          this help                  q  quit",
  "",
  "Runs execute the real CLI as a child process (--json).",
].join("\n");

interface TuiState {
  root: string;
  filter: string;
  items: QueueItem[];
  cursor: number;
  mode: Mode;
  focus: "files" | "form" | "modes";
  formRow: number;
  transcribeForm: TranscribeForm;
  enhanceForm: EnhanceForm;
  running: boolean;
  logs: string[];
  toast?: string;
  overlay: "none" | "help" | "quit" | "input" | "report";
  reportText: string;
  reportScroll: number;
  doctorText: string;
  listWindowStart: number;
}

export async function runTuiApp(): Promise<number> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });

  const state: TuiState = {
    root: process.cwd(),
    filter: "",
    items: [],
    cursor: 0,
    mode: "Transcribe",
    focus: "files",
    formRow: 0,
    enhanceForm: { ...DEFAULT_ENHANCE_FORM },
    transcribeForm: { ...DEFAULT_TRANSCRIBE_FORM },
    running: false,
    logs: ["Ready. Paste or drop files, or press d to set a scan directory."],
    overlay: "none",
    reportText: "",
    reportScroll: 0,
    doctorText: "",
    listWindowStart: 0,
  };

  let child: ChildProcess | null = null;
  let destroyed = false;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  // --- Static skeleton -------------------------------------------------------
  renderer.root.flexDirection = "column";

  const header = new BoxRenderable(renderer, { height: 1, flexDirection: "row" });
  header.add(new TextRenderable(renderer, { content: " media-transcriber ", fg: col(THEME.accent) }));
  const toastText = new TextRenderable(renderer, { content: "", fg: col(THEME.warn), flexGrow: 1 });
  header.add(toastText);

  const tabs = new TabSelectRenderable(renderer, {
    height: 2,
    options: MODES.map((mode) => ({ name: mode, description: "" })),
    showDescription: false,
    tabWidth: 14,
    textColor: col(THEME.fg),
    selectedTextColor: col(THEME.accent),
    selectedBackgroundColor: col(THEME.selectedBg),
  });
  tabs.on(TabSelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    state.mode = option.name as Mode;
    render();
  });

  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1 });

  const filesBox = new BoxRenderable(renderer, {
    width: 38,
    flexDirection: "column",
    borderStyle: "single",
    borderColor: col(THEME.border),
    title: "Files",
    titleColor: col(THEME.dim),
  });
  const filterInput = new InputRenderable(renderer, {
    placeholder: "filter files…",
    textColor: col(THEME.fg),
  });
  const listBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1 });
  const filesFooter = new TextRenderable(renderer, { content: "", fg: col(THEME.dim) });
  filesBox.add(filterInput);
  filesBox.add(listBox);
  filesBox.add(filesFooter);

  const mainBox = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    borderStyle: "single",
    borderColor: col(THEME.border),
    title: "main",
    titleColor: col(THEME.dim),
  });
  const formBox = new BoxRenderable(renderer, { flexDirection: "column" });
  const runBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1 });
  mainBox.add(formBox);
  mainBox.add(runBox);

  body.add(filesBox);
  body.add(mainBox);

  const footer = new TextRenderable(renderer, { content: "", fg: col(THEME.dim), height: 1 });

  const overlayHost = new BoxRenderable(renderer, {
    position: "absolute",
    width: "100%",
    height: "100%",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  });
  const overlayBox = new BoxRenderable(renderer, {
    flexDirection: "column",
    borderStyle: "rounded",
    borderColor: col(THEME.accent),
    backgroundColor: col("#1b1f24"),
    padding: 1,
    maxHeight: "80%",
    maxWidth: "80%",
  });
  const overlayText = new TextRenderable(renderer, { content: "", fg: col(THEME.fg) });
  overlayBox.add(overlayText);
  overlayHost.add(overlayBox);

  renderer.root.add(header);
  renderer.root.add(tabs);
  renderer.root.add(body);
  renderer.root.add(footer);
  renderer.root.add(overlayHost);

  // Dynamic children are tracked explicitly (the renderable API exposes
  // add/remove but no child enumeration).
  const listLines: TextRenderable[] = [];
  const formLines: TextRenderable[] = [];
  const runLines: TextRenderable[] = [];
  let overlayInput: InputRenderable | null = null;

  function clearLines(box: BoxRenderable, lines: TextRenderable[]) {
    for (const line of lines.splice(0)) box.remove(line);
  }

  // --- Derived helpers --------------------------------------------------------
  const listHeight = () => Math.max(4, renderer.height - 10);

  function visibleItems(): QueueItem[] {
    if (!state.filter) return state.items;
    return fuzzyFilter(state.filter, state.items, (item) => item.path).map((s) => s.item);
  }

  function visibleIndexToMaster(visible: QueueItem[], index: number): number {
    if (visible.length === 0) return -1;
    const item = visible[Math.min(index, visible.length - 1)]!;
    return state.items.indexOf(item);
  }

  // --- Rendering ---------------------------------------------------------------
  function render() {
    toastText.content = state.toast ?? "";
    tabs.setSelectedIndex(MODES.indexOf(state.mode));
    renderList();
    renderMain();
    renderFooter();
    renderOverlay();
    renderer.requestRender();
  }

  function renderList() {
    const visible = visibleItems();
    const height = listHeight();

    if (state.cursor >= visible.length) state.cursor = Math.max(0, visible.length - 1);
    if (state.cursor < state.listWindowStart) state.listWindowStart = state.cursor;
    if (state.cursor >= state.listWindowStart + height) {
      state.listWindowStart = state.cursor - height + 1;
    }

    clearLines(listBox, listLines);
    const slice = visible.slice(state.listWindowStart, state.listWindowStart + height);
    slice.forEach((item, i) => {
      const absoluteIndex = state.listWindowStart + i;
      const isCursor = state.focus === "files" && absoluteIndex === state.cursor && visible.length > 0;
      const status = STATUS_GLYPH[item.status];
      const checkbox = item.selected ? "[✓]" : "[ ]";
      const line = new TextRenderable(renderer, {
        content: `${isCursor ? "❯" : " "}${checkbox}${status.glyph} ${displayName(item.path, 24).padEnd(25)}${formatBytes(item.sizeBytes).padStart(8)}`,
        fg: col(item.status === "pending" ? THEME.fg : status.color),
        bg: isCursor ? col(THEME.selectedBg) : undefined,
      });
      line.onMouseDown = () => {
        const masterIndex = visibleIndexToMaster(visible, absoluteIndex);
        if (masterIndex >= 0) {
          state.items = toggleAt(state.items, masterIndex);
          render();
        }
      };
      listLines.push(line);
      listBox.add(line);
    });
    if (visible.length === 0) {
      const empty = new TextRenderable(renderer, {
        content: state.filter ? "(no matches)" : "(no media files — paste paths or press d)",
        fg: col(THEME.dim),
      });
      listLines.push(empty);
      listBox.add(empty);
    }

    const selectedCount = state.items.filter((item) => item.selected).length;
    filesFooter.content = ` ${selectedCount}/${state.items.length} selected · ${state.root}`.slice(0, 36);
  }

  interface FormRow {
    label: string;
    value: string;
    kind: "cycle" | "text";
  }

  function formRows(): FormRow[] {
    if (state.mode === "Transcribe") {
      const f = state.transcribeForm;
      return [
        { label: "Backend", value: f.backend, kind: "cycle" },
        { label: "Model", value: f.model.trim() || "(default)", kind: "text" },
        { label: "Preset", value: f.preset || "(off)", kind: "cycle" },
        { label: "Formats", value: f.formats, kind: "cycle" },
        { label: "Output dir", value: f.outputDir.trim() || "(next to file)", kind: "text" },
        { label: "Enhance", value: f.enhancer, kind: "cycle" },
        { label: "Enh. profile", value: f.enhanceProfile, kind: "cycle" },
        { label: "Split at (s)", value: f.splitThreshold.trim() || "(1200)", kind: "text" },
      ];
    }
    if (state.mode === "Enhance") {
      const f = state.enhanceForm;
      return [
        { label: "Engine", value: f.enhancer, kind: "cycle" },
        { label: "Profile", value: f.profile, kind: "cycle" },
        { label: "Output dir", value: f.outputDir.trim() || "(next to file)", kind: "text" },
        { label: "Report", value: f.report ? "write report" : "no report", kind: "cycle" },
      ];
    }
    return [];
  }

  function cycleValue<T extends string>(values: readonly T[], current: T, direction: 1 | -1): T {
    const index = values.indexOf(current);
    const next = (index + direction + values.length) % values.length;
    return values[next] ?? values[0]!;
  }

  function applyCycle(row: FormRow, direction: 1 | -1) {
    if (state.mode === "Transcribe") {
      const f = state.transcribeForm;
      switch (row.label) {
        case "Backend": f.backend = cycleValue(BACKENDS, f.backend, direction); break;
        case "Preset": f.preset = cycleValue(PRESETS, f.preset, direction); break;
        case "Formats": f.formats = cycleValue(FORMATS, f.formats, direction); break;
        case "Enhance": f.enhancer = cycleValue(ENHANCERS, f.enhancer, direction); break;
        case "Enh. profile": f.enhanceProfile = cycleValue(ENHANCE_PROFILE, f.enhanceProfile, direction); break;
      }
    } else {
      const f = state.enhanceForm;
      switch (row.label) {
        case "Engine": f.enhancer = cycleValue(ENHANCE_ENGINES, f.enhancer, direction); break;
        case "Profile": f.profile = cycleValue(ENHANCE_PROFILE, f.profile, direction); break;
        case "Report": f.report = !f.report; break;
      }
    }
  }

  function renderMain() {
    mainBox.title = state.mode.toLowerCase();
    clearLines(formBox, formLines);
    clearLines(runBox, runLines);

    if (state.mode === "Doctor") {
      const text = new TextRenderable(renderer, {
        content: state.doctorText || "Press r to run a readiness check.",
        fg: col(THEME.fg),
      });
      formLines.push(text);
      formBox.add(text);
      return;
    }

    const rows = formRows();
    rows.forEach((row, i) => {
      const isCursor = state.focus === "form" && i === state.formRow;
      const line = new TextRenderable(renderer, {
        content: `${isCursor ? "❯ " : "  "}${row.label.padEnd(14)}${row.value}${row.kind === "cycle" ? "  ←→" : "  ⏎"}`,
        fg: col(isCursor ? THEME.accent : THEME.fg),
        bg: isCursor ? col(THEME.selectedBg) : undefined,
      });
      formLines.push(line);
      formBox.add(line);
    });

    const runHint = new TextRenderable(renderer, {
      content: state.running
        ? `Running… (${state.logs.length} events)`
        : `r: run on ${selectedPaths(state.items).length} selected file(s)`,
      fg: col(state.running ? THEME.warn : THEME.accent),
    });
    runHint.onMouseDown = () => {
      if (!state.running) void startRun();
    };
    formLines.push(runHint);
    formBox.add(runHint);

    const logHeight = Math.max(3, renderer.height - rows.length - 8);
    for (const line of state.logs.slice(-logHeight)) {
      const fg = line.startsWith("✓") ? THEME.ok
        : line.startsWith("✗") ? THEME.err
        : line.startsWith("▶") ? THEME.accent
        : THEME.dim;
      const text = new TextRenderable(renderer, { content: line, fg: col(fg) });
      runLines.push(text);
      runBox.add(text);
    }
  }

  function renderFooter() {
    footer.content = ` tab:focus(${state.focus})  space:select  r:run  ?:help  q:quit${state.running ? "  (run active)" : ""}`;
  }

  function closeOverlayInput() {
    if (overlayInput) {
      overlayBox.remove(overlayInput);
      overlayInput = null;
    }
  }

  function renderOverlay() {
    if (state.overlay === "none") {
      overlayHost.visible = false;
      overlayBox.visible = false;
      return;
    }
    overlayHost.visible = true;
    overlayBox.visible = true;
    if (state.overlay === "help") overlayText.content = HELP_TEXT;
    else if (state.overlay === "quit") {
      overlayText.content = "A run is active.\n\n  y: kill it and quit   n/esc: stay";
    } else if (state.overlay === "report") {
      const lines = state.reportText.split("\n");
      const height = Math.max(4, Math.floor(renderer.height * 0.6));
      const start = Math.min(state.reportScroll, Math.max(0, lines.length - height));
      overlayText.content = lines.slice(start, start + height).join("\n") || "(empty report)";
    } else if (state.overlay === "input") {
      overlayText.content = "";
    }
  }

  // --- Toast ---------------------------------------------------------------------
  function toast(message: string) {
    state.toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = undefined;
      render();
    }, 3500);
  }

  function pushLog(line: string | null) {
    if (line === null) return;
    state.logs.push(line.slice(0, 200));
    if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
  }

  // --- Queue staging ---------------------------------------------------------------
  function stagePaths(paths: string[]): number {
    const known = new Set(state.items.map((item) => item.path));
    const fresh = paths.filter((path) => !known.has(path));
    if (fresh.length > 0) {
      void buildQueue(fresh, true).then((items) => {
        state.items = [...state.items, ...items];
        render();
      });
    }
    return fresh.length;
  }

  async function rescan(rootDir = state.root) {
    const paths = await scanMediaFiles(rootDir);
    state.root = rootDir;
    const byPath = new Map(state.items.map((item) => [item.path, item]));
    state.items = await buildQueue(paths, true);
    state.items = state.items.map((item) => byPath.get(item.path) ?? item);
    state.cursor = 0;
    state.listWindowStart = 0;
    render();
  }

  // --- Child process execution --------------------------------------------------------
  interface ChildResult {
    code: number | null;
    stdout: string;
  }

  function spawnCli(args: string[]): Promise<ChildResult> {
    const entry = process.argv[1]!;
    const active = spawn(process.execPath, [entry, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = active;
    let stdout = "";
    let stderrBuffer = "";
    const { promise, resolve: resolveResult } = Promise.withResolvers<ChildResult>();

    active.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    active.stderr!.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      let newline = stderrBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        const event = parseProgressLine(line);
        if (event) pushLog(describeProgressEvent(event));
        newline = stderrBuffer.indexOf("\n");
      }
      render();
    });
    active.on("close", (code) => {
      if (active === child) child = null;
      resolveResult({ code, stdout });
    });
    return promise;
  }

  async function startRun() {
    if (state.running) return;
    if (state.mode === "Doctor") {
      state.running = true;
      state.logs = [];
      render();
      const result = await spawnCli(buildDoctorArgs());
      state.doctorText = renderDoctor(result.stdout);
      state.running = false;
      render();
      return;
    }
    const targets = selectedPaths(state.items);
    if (targets.length === 0) {
      toast("No files selected");
      return;
    }

    state.running = true;
    state.logs = [];
    render();
    try {
      for (const target of targets) {
        const masterIndex = state.items.findIndex((item) => item.path === target);
        if (masterIndex === -1) continue;
        state.items[masterIndex]!.status = "running";
        render();

        const args = state.mode === "Transcribe"
          ? buildTranscribeArgs(state.transcribeForm, target)
          : buildEnhanceArgs(state.enhanceForm, target);
        const result = await spawnCli(args);

        const item = state.items[masterIndex]!;
        const outcome = parseRunOutcome(result.stdout);
        if (result.code === 0 && outcome.success) {
          state.items[masterIndex] = {
            ...item,
            status: "done",
            output: outcome.output,
            reportPath: outcome.reportPath,
            error: undefined,
          };
        } else {
          state.items[masterIndex] = {
            ...item,
            status: "failed",
            error: outcome.error ?? `exit ${result.code ?? "?"}`,
          };
        }
        render();
      }
    } finally {
      state.running = false;
      render();
    }
  }

  interface RunOutcome {
    success: boolean;
    output?: string;
    reportPath?: string;
    error?: string;
  }

  function parseRunOutcome(stdout: string): RunOutcome {
    try {
      const parsed = JSON.parse(stdout.trim()) as {
        files?: Array<{
          success: boolean;
          error?: string;
          output?: { txt?: string | null; srt?: string | null };
          enhancement?: { outputFile?: string };
        }>;
      };
      const file = parsed.files?.[0];
      if (!file) return { success: false, error: "no result from child" };
      if (!file.success) return { success: false, error: file.error };
      const enhanced = file.enhancement?.outputFile;
      return {
        success: true,
        output: enhanced ?? file.output?.txt ?? file.output?.srt ?? undefined,
        reportPath: enhanced ? reportPathFor(enhanced) : undefined,
      };
    } catch {
      return { success: false, error: "unreadable child output" };
    }
  }

  function reportPathFor(enhancedFile: string): string {
    const base = basename(enhancedFile, ".wav").replace(/_enhanced$/, "");
    return `${dirname(enhancedFile)}/${base}_enhancement.json`;
  }

  function renderDoctor(stdout: string): string {
    try {
      const report = JSON.parse(stdout.trim()) as {
        ready?: boolean;
        dependencies?: { ffmpeg?: { available?: boolean }; ffprobe?: { available?: boolean } };
        backends?: Array<{ displayName?: string; available?: boolean; error?: string }>;
        enhancers?: Array<{ displayName?: string; available?: boolean; error?: string }>;
      };
      const lines: string[] = [];
      const mark = (ok?: boolean) => (ok ? "✓" : "✗");
      lines.push(
        `ffmpeg ${mark(report.dependencies?.ffmpeg?.available)}   ffprobe ${mark(report.dependencies?.ffprobe?.available)}   ready: ${report.ready ? "yes" : "no"}`,
        "",
        "Backends:",
      );
      for (const backend of report.backends ?? []) {
        lines.push(`  ${mark(backend.available)} ${backend.displayName}${backend.available ? "" : ` — ${backend.error ?? "unavailable"}`}`);
      }
      lines.push("", "Enhancers:");
      for (const enhancer of report.enhancers ?? []) {
        lines.push(`  ${mark(enhancer.available)} ${enhancer.displayName}${enhancer.available ? "" : ` — ${enhancer.error ?? "unavailable"}`}`);
      }
      return lines.join("\n");
    } catch {
      return "Doctor run failed or produced unreadable output.";
    }
  }

  // --- Extras --------------------------------------------------------------------------
  function openInSystemApp(path: string) {
    if (!existsSync(path)) {
      toast(`Not found: ${basename(path)}`);
      return;
    }
    const opener =
      process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const openerArgs = process.platform === "win32" ? ["/c", "start", "", path] : [path];
    spawn(opener, openerArgs, { detached: true, stdio: "ignore" }).unref();
    toast(`Opening ${basename(path)}`);
  }

  async function showReport(masterIndex: number) {
    const item = state.items[masterIndex];
    if (!item) return;
    if (item.reportPath && existsSync(item.reportPath)) {
      state.reportText = await readFile(item.reportPath, "utf-8");
    } else if (item.output?.endsWith(".wav")) {
      state.reportText = "No report file found. Run Enhance with report enabled.";
    } else {
      state.reportText = "No enhancement report. Reports come from Enhance mode (--report).";
    }
    state.reportScroll = 0;
    state.overlay = "report";
    render();
  }

  // --- Input handling --------------------------------------------------------------------
  filterInput.on(InputRenderableEvents.INPUT, (value: string) => {
    state.filter = value;
    state.cursor = 0;
    state.listWindowStart = 0;
    render();
  });

  function setFocus(focus: TuiState["focus"]) {
    state.focus = focus;
    if (focus === "files") filterInput.focus();
    else if (focus === "modes") tabs.focus();
    else filterInput.blur();
    render();
  }

  function openInputOverlay(initial: string, placeholder: string, onSubmit: (value: string) => void) {
    closeOverlayInput();
    overlayInput = new InputRenderable(renderer, {
      value: initial,
      placeholder,
      width: 50,
      textColor: col(THEME.fg),
    });
    const input = overlayInput;
    overlayBox.add(input);
    state.overlay = "input";
    input.focus();
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      closeOverlayInput();
      state.overlay = "none";
      onSubmit(value);
      render();
    });
    render();
  }

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // While the filter input holds focus, letters must type into it; only
    // escape/tab and ctrl-modified globals pass through. The mode tabs
    // consume just arrows/enter, so every key stays global there.
    const filterFocused = state.focus === "files";
    if (filterFocused && key.ctrl !== true && !["escape", "tab"].includes(key.name)) return;

    if (state.overlay === "help" || state.overlay === "report") {
      if (key.name === "escape" || key.name === "q") {
        state.overlay = "none";
        render();
      } else if (state.overlay === "report") {
        if (key.name === "down" || key.name === "j") {
          state.reportScroll += 1;
          render();
        } else if (key.name === "up" || key.name === "k") {
          state.reportScroll = Math.max(0, state.reportScroll - 1);
          render();
        }
      }
      return;
    }
    if (state.overlay === "quit") {
      if (key.name === "y") {
        child?.kill("SIGTERM");
        shutdown();
      } else if (key.name === "n" || key.name === "escape") {
        state.overlay = "none";
        render();
      }
      return;
    }

    switch (key.name) {
      case "tab":
        setFocus(state.focus === "files" ? "form" : state.focus === "form" ? "modes" : "files");
        return;
      case "q":
        if (state.running) {
          state.overlay = "quit";
          render();
        } else {
          shutdown();
        }
        return;
      case "escape":
        // escape never quits; with the filter focused it clears the filter
        if (state.focus === "files" && state.filter.length > 0) {
          state.filter = "";
          filterInput.value = "";
          state.cursor = 0;
          state.listWindowStart = 0;
          render();
        }
        return;
      case "?":
      case "/":
        state.overlay = "help";
        render();
        return;
      case "1":
      case "2":
      case "3":
        if (!state.running) {
          state.mode = MODES[Number.parseInt(key.name, 10) - 1]!;
          render();
        }
        return;
      case "r":
        if (!state.running) void startRun();
        return;
      case "g":
        void rescan();
        return;
      case "d":
        if (!state.running) {
          openInputOverlay("", "scan directory…", (value) => {
            const target = resolve(value.trim() || ".");
            if (existsSync(target)) void rescan(target);
            else toast(`No such directory: ${target}`);
          });
        }
        return;
      case "p":
        void stageFromClipboard();
        return;
      case "o": {
        const masterIndex = visibleIndexToMaster(visibleItems(), state.cursor);
        if (masterIndex >= 0) {
          const item = state.items[masterIndex]!;
          if (item.output) openInSystemApp(item.output);
          else toast("No output yet — run first");
        }
        return;
      }
      case "v": {
        const masterIndex = visibleIndexToMaster(visibleItems(), state.cursor);
        if (masterIndex >= 0) void showReport(masterIndex);
        return;
      }
      default:
        break;
    }

    if (state.focus === "files") {
      const visible = visibleItems();
      if (key.name === "down" || key.name === "j") {
        state.cursor = Math.min(visible.length - 1, state.cursor + 1);
        render();
      } else if (key.name === "up" || key.name === "k") {
        state.cursor = Math.max(0, state.cursor - 1);
        render();
      } else if (key.name === "space") {
        const masterIndex = visibleIndexToMaster(visible, state.cursor);
        if (masterIndex >= 0) {
          state.items = toggleAt(state.items, masterIndex);
          render();
        }
      } else if (key.name === "a") {
        const anyUnselected = state.items.some((item) => !item.selected);
        state.items = selectAll(state.items, anyUnselected);
        render();
      }
      return;
    }

    if (state.focus === "form") {
      const rows = formRows();
      if (key.name === "down" || key.name === "j") {
        state.formRow = Math.min(rows.length - 1, state.formRow + 1);
        render();
      } else if (key.name === "up" || key.name === "k") {
        state.formRow = Math.max(0, state.formRow - 1);
        render();
      } else if (key.name === "left") {
        applyCycle(rows[state.formRow]!, -1);
        render();
      } else if (key.name === "right") {
        applyCycle(rows[state.formRow]!, 1);
        render();
      } else if (key.name === "return") {
        const row = rows[state.formRow]!;
        if (row.kind === "text") {
          const initial = state.mode === "Transcribe"
            ? row.label === "Model" ? state.transcribeForm.model
              : row.label === "Output dir" ? state.transcribeForm.outputDir
              : state.transcribeForm.splitThreshold
            : state.enhanceForm.outputDir;
          openInputOverlay(initial, row.label.toLowerCase(), (value) => {
            if (state.mode === "Transcribe") {
              const f = state.transcribeForm;
              if (row.label === "Model") f.model = value;
              else if (row.label === "Output dir") f.outputDir = value;
              else f.splitThreshold = value;
            } else {
              state.enhanceForm.outputDir = value;
            }
            setFocus("form");
          });
        }
      }
    }
  });

  async function stageFromClipboard() {
    try {
      const { createClipboard, createHostClipboard, createRendererClipboardAdapter } =
        await import("@opentui/core");
      const clipboard = createClipboard({
        host: createHostClipboard(),
        terminal: createRendererClipboardAdapter(renderer),
      });
      const result = await clipboard.read({ preferredTypes: ["text/plain"] });
      await clipboard.dispose();
      if (result.status !== "read") {
        toast("Clipboard unavailable");
        return;
      }
      handlePastedText(new TextDecoder().decode(result.representation.bytes));
    } catch {
      toast("Clipboard unavailable on this system");
    }
  }

  function handlePastedText(text: string) {
    const parsed = parsePastedPaths(text, {
      exists: (path) => existsSync(path),
      isFile: (path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      },
    });
    const staged = stagePaths(parsed.files);
    if (parsed.dirs.length > 0 && existsSync(parsed.dirs[0]!)) {
      void rescan(parsed.dirs[0]!);
      toast(`Scanning ${parsed.dirs[0]!}${staged ? ` (+${staged} staged)` : ""}`);
      return;
    }
    const parts: string[] = [];
    if (staged > 0) parts.push(`+${staged} file${staged === 1 ? "" : "s"} staged`);
    if (parsed.rejected.length > 0) parts.push(`${parsed.rejected.length} rejected`);
    if (parts.length === 0) parts.push("no paths found in paste");
    toast(parts.join(" · "));
  }

  renderer.keyInput.on("paste", (event: PasteEvent) => {
    handlePastedText(new TextDecoder().decode(event.bytes));
  });

  function shutdown() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(toastTimer);
    child?.kill("SIGTERM");
    renderer.destroy();
  }

  renderer.on("destroy", () => {
    destroyed = true;
    child?.kill("SIGTERM");
  });

  setFocus("files");
  await rescan();

  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
  const check = setInterval(() => {
    if (destroyed) {
      clearInterval(check);
      resolveExited(0);
    }
  }, 100);
  return exited;
}

// Keep the Renderable import meaningful for the child-tracking types above.
export type { Renderable };
