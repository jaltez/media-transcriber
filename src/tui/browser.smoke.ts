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
let exitedEarly = false;
app.exited.then(() => {
  exitedEarly = true;
});
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
  check("'q' types into search without quitting the app", !exitedEarly && f.includes("q:quit"));

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

  // 8. 'd' overlay: typing must not fire global hotkeys (q quits, r runs).
  await setup.mockInput.pressKey("d");
  await settle();
  await setup.mockInput.typeText("quiet recordings");
  await settle();
  f = frame();
  check("'d' overlay typing does not quit or run", !exitedEarly && f.includes("quiet recordings"));
  await setup.mockInput.pressKey(KeyCodes.ESCAPE);
  await settle();
  f = frame();
  check("escape closes the 'd' overlay without submitting", !f.includes("quiet recordings"));

  // 9. 'd' resolves relative paths against the browsed directory.
  await setup.mockInput.pressKey(KeyCodes.RETURN); // cursor on sub/
  await settle();
  await setup.mockInput.pressKey("d");
  await settle();
  await setup.mockInput.typeText("deep");
  await setup.mockInput.pressKey(KeyCodes.RETURN);
  await settle();
  f = frame();
  check("'d' jumps relative to the browsed folder", f.includes("nested.mp3"));

  // 10. Remote-engine consent: cycling Engine onto unise reveals the
  // 'Allow upload' toggle and warns without consent.
  await setup.mockInput.pressKey("h"); // back to the fixture root
  await settle();
  await setup.mockInput.pressKey("2"); // Enhance mode
  await setup.mockInput.pressKey(KeyCodes.TAB); // focus the form
  await setup.mockInput.pressKey(KeyCodes.ARROW_RIGHT); // basic -> deepfilternet
  await setup.mockInput.pressKey(KeyCodes.ARROW_RIGHT); // deepfilternet -> unise
  await settle();
  f = frame();
  check("unise engine shows the Allow upload toggle", f.includes("unise") && f.includes("Allow upload"));
  check("unise without consent warns about upload", f.includes("remote service"));
  await setup.mockInput.pressKey(KeyCodes.ARROW_DOWN); // cursor on Allow upload
  await setup.mockInput.pressKey(KeyCodes.ARROW_RIGHT); // consent
  await settle();
  f = frame();
  check("Allow upload cycles to consented", f.includes("consented"));

  // 11. Staged-queue view: see everything staged across folders, unstage, clear.
  await setup.mockInput.pressKey(KeyCodes.TAB); // form -> modes
  await setup.mockInput.pressKey(KeyCodes.TAB); // modes -> files
  await settle();
  await setup.mockInput.pressKey("s"); // open the queue view
  await settle();
  f = frame();
  check("queue view lists every staged file", f.includes("Queue") && f.includes("clip.wav") && f.includes("nested.mp3"));
  await setup.mockInput.pressKey(" "); // unstage the first (clip.wav)
  await settle();
  f = frame();
  check("space unstages from the queue", f.includes("1 staged") && !f.includes("clip.wav"));
  await setup.mockInput.pressKey("a"); // clear the rest
  await settle();
  f = frame();
  check("'a' clears the queue", f.includes("queue empty"));
  await setup.mockInput.pressKey("s"); // back to the browser
  await settle();
  f = frame();
  check("'s' returns to the browser", f.includes("Files"));
  // 11. final escape; teardown below (app still running normally).
  await setup.mockInput.pressKey(KeyCodes.ESCAPE);
  await setup.renderOnce();
} finally {
  app.destroy();
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nbrowser smoke: all checks passed" : `\nbrowser smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
