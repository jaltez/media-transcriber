/**
 * Headless integration test for the TUI file browser. Runs under Bun only
 * (OpenTUI's native core requires it on this repo's toolchain):
 *
 *   bun src/tui/browser.smoke.ts
 *
 * Drives the real app through OpenTUI's createTestRenderer + mockInput and
 * asserts on rendered frames: directory navigation, media-only default,
 * recursive '/' search with hotkey isolation, staging files and folders,
 * and quitting from the filter.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer, KeyCodes } from "@opentui/core/testing";
import { createTuiApp } from "./app.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    console.log("--- frame at failure ---");
    console.log(frame().split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim()).join("\n"));
    console.log("--- end frame ---");
  }
}

const dir = await mkdtemp(join(tmpdir(), "mt-browser-smoke-"));
const sub = join(dir, "sub");
const deep = join(sub, "deep");
await mkdir(sub);
await mkdir(deep);
await writeFile(join(dir, "clip.wav"), "x");
await writeFile(join(dir, "notes.txt"), "not media");
await writeFile(join(deep, "nested.mp3"), "x");

const setup = await createTestRenderer({ width: 100, height: 30 });
const app = createTuiApp(setup.renderer, dir);
await app.ready;
const frame = () => setup.captureCharFrame();
// fs-backed state changes (loadDir, scans, staging) settle asynchronously;
// give them a beat before capturing a frame.
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await setup.renderOnce();
};

try {
  await settle();

  // 1. Browser lists folders first, media only by default.
  let f = frame();
  check("lists folders before files", f.indexOf("sub/") !== -1 && f.indexOf("clip.wav") !== -1 && f.indexOf("sub/") < f.indexOf("clip.wav"));
  check("hides non-media files by default", !f.includes("notes.txt"));
  check("shows staged count and cwd basename in footer", f.includes("staged") && f.includes("mt-browser-smoke-"));

  // 2. 't' reveals all files.
  await setup.mockInput.pressKey("t");
  await settle();
  f = frame();
  check("'t' shows non-media files", f.includes("notes.txt"));
  await setup.mockInput.pressKey("t");
  await settle();

  // 3. Navigate into a folder and back out.
  // cursor starts on sub/ (first row)
  await setup.mockInput.pressKey(KeyCodes.RETURN);
  await settle();
  f = frame();
  check("enter opens folder", f.includes("deep/"));
  await setup.mockInput.pressKey("h");
  await settle();
  f = frame();
  check("'h' returns to parent", f.includes("clip.wav") && !f.includes("nested.mp3"));

  // 4. '/' opens recursive search; hotkeys do NOT leak while typing.
  await setup.mockInput.pressKey("/");
  await setup.mockInput.typeText("nested");
  await settle();
  f = frame();
  check("recursive search finds nested media", f.includes("nested.mp3"));
  check("help overlay does not leak on '/'", !f.includes("media-transcriber TUI — keys"));
  await setup.mockInput.typeText("qqq");
  await settle();
  f = frame();
  check("'q' types into search instead of quitting", !f.includes("TUI — keys"));

  // 5. escape exits search back to the browser.
  await setup.mockInput.pressKey(KeyCodes.ESCAPE);
  await settle();
  f = frame();
  check("escape returns to folder listing", f.includes("sub/"));

  // 6. space stages a file; staged count shows in the footer.
  await setup.mockInput.pressKey(KeyCodes.ARROW_DOWN); // clip.wav
  await setup.mockInput.pressKey(" ");
  await settle();
  f = frame();
  check("space stages the cursor file", f.includes("1 staged"));

  // 7. space on a folder stages it recursively.
  await setup.mockInput.pressKey(KeyCodes.ARROW_UP); // sub/
  await setup.mockInput.pressKey(" ");
  await settle();
  f = frame();
  check("space on a folder stages it recursively", f.includes("2 staged"));

  // 8. tab exits filter/search focus; q with an empty filter quits.
  await setup.mockInput.pressKey(KeyCodes.ESCAPE);
  await setup.renderOnce();
} finally {
  app.destroy();
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nbrowser smoke: all checks passed" : `\nbrowser smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
