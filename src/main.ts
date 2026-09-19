import "./styles.css";
import { cloudConfig, MAX_DATA_BYTES } from "./config";
import {
  createLivePayload,
  FutureScanTimeError,
  MissingScanTimeError,
} from "./live-time";
import { CloudStore, type QrState, type QrCapture } from "./cloud";
import { CameraScanner, decodeImage, generateQr } from "./qr";

const icons = {
  qr: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 14v7h6v-4h-3M20 13v1"/>',
  upload:
    '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  camera:
    '<path d="m8 5 1-2h6l1 2h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="12" cy="12" r="4"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-1-10 7 7 0 0 1 13 2 4 4 0 0 1-1 8H7Z"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  download:
    '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zm0 0v6h6M8 13h8M8 17h5"/>',
};
function icon(name: keyof typeof icons, css = "") {
  return `<svg class="icon ${css}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="site-header"><div class="header-inner">
    <a class="brand" href="./" aria-label="QR Data Manager home"><span class="brand-mark">${icon("qr")}</span><span>QR Data Manager</span></a>
    <span id="cloud-status" class="connection" role="status"><span class="status-dot"></span><span id="cloud-status-text">Connecting</span></span>
  </div></header>
  <main>
    <section class="intro" aria-labelledby="page-title">
      <div><div class="eyebrow"><span class="tiny-line"></span> YOUR QR WORKSPACE</div><h1 id="page-title">One scan. Ready anywhere.</h1><p>Scan once. Keep your QR time current in 15-second steps, on any device.</p></div>
      <div class="workflow" aria-label="Scan, sync, refresh"><span>${icon("camera")} Scan</span><span class="flow-line"></span><span>${icon("cloud")} Sync</span><span class="flow-line"></span><span>${icon("qr")} Refresh</span></div>
    </section>
    <aside id="setup-banner" class="setup-banner" hidden><span class="setup-icon">${icon("cloud")}</span><div><strong>Connect your shared workspace</strong><p>Cloud storage needs to be configured before your first save.</p><details><summary>View setup steps</summary><ol><li>Run <code>supabase/schema.sql</code> in your Supabase SQL Editor.</li><li>Set the Supabase URL and public key using <code>.env.example</code>.</li><li>Rebuild and deploy. The included README has the full setup guide.</li></ol><p>Use only a publishable or legacy anon key. Private keys do not belong in this app.</p></details></div></aside>
    <div class="workspace">
      <div class="source-column">
        <section class="card capture-card" aria-labelledby="capture-title">
          <div class="card-heading"><span class="step">01</span><div><h2 id="capture-title">Read a QR code</h2><p>Start with an image or your camera.</p></div></div>
          <label id="drop-zone" class="drop-zone" for="qr-file">
            <input id="qr-file" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" />
            <span class="upload-symbol">${icon("upload")}</span><strong>Upload QR image</strong><span>Choose a file <span class="desktop-hint">or drag it here</span></span><small>JPG, PNG or WebP · up to 20 MB</small>
          </label>
          <div class="or-divider"><span></span>or<span></span></div>
          <button id="scan-btn" class="button secondary full">${icon("camera")} Scan with camera</button>
          <p id="capture-message" class="message" role="status" aria-live="polite" hidden></p>
        </section>
        <section class="card saved-card" aria-labelledby="saved-title">
          <div class="section-heading"><h2 id="saved-title">Last read QR data</h2><button id="refresh-btn" class="icon-button" title="Refresh cloud data" aria-label="Refresh cloud data">${icon("refresh")}</button></div>
          <div id="source-empty" class="empty-source">${icon("file")}<p>No QR data yet<span>Upload or scan a QR code to get started.</span></p></div>
          <pre id="source-data" class="data-box source-data" tabindex="0" hidden></pre>
          <div class="source-footer"><span id="source-badge" class="small-badge">Awaiting first scan</span><span id="source-size" class="subtle"></span></div>
          <div class="saved-meta">${icon("cloud")}<span id="source-meta">Your latest scan will be saved across devices.</span></div>
          <p id="cloud-message" class="message" role="status" hidden></p>
          <div id="pending-actions" class="button-row" hidden><button id="retry-save" class="button primary small">Save again</button><button id="discard-pending" class="button secondary small">Discard unsaved scan</button></div>
        </section>
        <div class="device-note">${icon("globe")}<p><strong>Home to office, without the extra steps.</strong><span>Open this same website on another device to pick up your latest saved scan.</span></p></div>
      </div>
      <section class="card output-card" aria-labelledby="output-title">
        <div class="card-heading"><span class="step">02</span><div><h2 id="output-title">Your QR, kept current</h2><p>The same data. A time that stays in step.</p></div><span class="live-badge">15s refresh</span></div>
        <div class="clock-grid" aria-label="QR time calculation">
          <div><span class="field-label">ORIGINAL QR TIME</span><code id="original-time">—</code></div>
          <div><span class="field-label">CURRENT TIME</span><code id="current-time">—</code></div>
          <div class="active-time"><span class="field-label">LIVE QR TIME</span><code id="qr-time">—</code></div>
        </div>
        <div class="clock-note">${icon("globe")} Device time · <span id="clock-timezone"></span></div>
        <div class="elapsed-panel" aria-label="Elapsed time calculation">
          <div class="timestamp-row"><span>Original timestamp inside QR</span><code id="original-timestamp">—</code></div>
          <div class="timestamp-row"><span>System time at scan (saved)</span><code id="baseline-timestamp">—</code></div>
          <div class="timestamp-row"><span>Current system time</span><code id="current-timestamp">—</code></div>
          <div class="duration-grid"><div><span class="field-label">ELAPSED SINCE THE SCAN</span><code id="elapsed-duration">—</code></div><div><span class="field-label">ROUNDED DOWN TO 15s</span><code id="rounded-duration">—</code></div></div>
          <p id="elapsed-calculation" class="elapsed-formula">Current system time − saved system time at scan</p>
          <details class="clock-details"><summary>How the clock is interpreted</summary><p>The system time is captured when this website successfully reads the QR and saved in UTC. Both system times are displayed in this device’s timezone. Opening the page again keeps the saved scan time.</p><p>Saved system time at scan in UTC: <code id="baseline-interpretation">—</code></p><p>Elapsed time is current system time minus saved system time at scan. Completed 15-second intervals are added to the time inside the original QR; its date and other text stay unchanged.</p></details>
        </div>
        <div class="live-status"><span id="qr-live-state">Waiting for a saved QR</span><span id="next-update">—</span></div>
        <button id="generate-btn" class="button primary full generate-button" disabled>${icon("refresh")}<span>Refresh QR now</span>${icon("arrow", "trailing")}</button>
        <div class="output-area">
          <div id="qr-placeholder" class="qr-placeholder"><div class="qr-placeholder-mark">${icon("qr")}</div><strong>Your live QR goes here</strong><span>Scan a QR with a date and time to start.</span></div>
          <div id="qr-result" class="qr-result" hidden><div class="qr-image-wrap"><img id="generated-qr" alt="QR code containing the updated time and otherwise unchanged text shown below" width="240" height="240" /></div><span class="ready-label">${icon("check")} Updates automatically</span></div>
        </div>
        <div class="combined-heading"><label for="combined-data" class="field-label">UPDATED QR DATA</label><span id="combined-size" class="subtle"></span></div>
        <pre id="combined-data" class="data-box combined-data" tabindex="0">Your updated QR text will appear here.</pre>
        <div class="output-actions"><a id="download-btn" class="button secondary" download="live-qr.png" aria-disabled="true" tabindex="-1">${icon("download")} Download PNG</a><button id="copy-btn" class="button secondary" disabled>${icon("copy")} Copy data</button></div>
        <p id="output-message" class="message" role="status" aria-live="polite" hidden></p>
      </section>
    </div>
    <footer><span>${icon("qr")} Small tool. Seamless handoff.</span><span>One shared record<span class="footer-dot">·</span>Plain-text data</span></footer>
  </main>
  <dialog id="camera-dialog" aria-labelledby="camera-title"><div class="dialog-heading"><div><span class="eyebrow">LIVE SCAN</span><h2 id="camera-title">Point your camera at a QR</h2></div><button id="close-camera" class="icon-button" aria-label="Close camera">${icon("close")}</button></div><div class="camera-view"><video id="camera-video" autoplay playsinline muted></video><div class="scan-frame" aria-hidden="true"></div></div><p id="camera-message" role="status">Keep the full QR code inside the frame.</p><button id="cancel-camera" class="button secondary full">Cancel scan</button></dialog>
`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function message(
  id: string,
  text = "",
  kind: "error" | "success" | "info" = "info",
) {
  const target = element(id);
  target.textContent = text;
  target.hidden = !text;
  target.className = `message ${kind}`;
}
function friendly(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
function localTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(now.getFullYear()).padStart(4, "0")}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
function duration(milliseconds: number): string {
  const seconds = Math.floor(Math.abs(milliseconds) / 1000);
  const days = Math.floor(seconds / 86400);
  const time = [
    Math.floor((seconds % 86400) / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return `${milliseconds < 0 ? "−" : ""}${days ? `${days}d ` : ""}${time}`;
}
const config = cloudConfig();
const cloud = config ? new CloudStore(config) : null;
let saved: QrState | null = null;
let pending: QrCapture | null = null;
let busy = false;
let reading = false;
let generating = false;
let dataVersion = 0;
let generationVersion = 0;
let output: { text: string; png: string } | null = null;
let requestedText: string | null = null;
let failedSource: string | null = null;
let invalidTimestamp = false;
let generationTask: Promise<void> | null = null;
let clockTimer: ReturnType<typeof setTimeout> | null = null;

function connection(text: string, state: "connected" | "warning" | "loading") {
  element("cloud-status-text").textContent = text;
  element("cloud-status").className = `connection ${state}`;
}
function clearRenderedQr() {
  output = null;
  element("qr-result").hidden = true;
  element("qr-placeholder").hidden = false;
  element<HTMLImageElement>("generated-qr").removeAttribute("src");
  element("combined-data").textContent =
    "Your updated QR text will appear here.";
  element("combined-data").classList.remove("has-data");
  element("combined-size").textContent = "";
  element<HTMLAnchorElement>("download-btn").removeAttribute("href");
}
function invalidateOutput() {
  generationVersion++;
  generating = false;
  requestedText = null;
  failedSource = null;
  invalidTimestamp = false;
  generationTask = null;
  clearRenderedQr();
  element("original-time").textContent = "—";
  for (const id of [
    "baseline-timestamp",
    "original-timestamp",
    "baseline-interpretation",
    "elapsed-duration",
    "rounded-duration",
  ]) {
    element(id).textContent = "—";
  }
  element("elapsed-calculation").textContent =
    "Current system time − saved system time at scan";
  element("qr-time").textContent = "—";
  element("next-update").textContent = "—";
  element("qr-live-state").textContent = "Waiting for a saved QR";
  message("output-message");
  updateButtons();
}
function updateButtons() {
  element<HTMLInputElement>("qr-file").disabled = busy;
  element("drop-zone").classList.toggle("is-busy", busy);
  element<HTMLButtonElement>("scan-btn").disabled = busy;
  element<HTMLButtonElement>("refresh-btn").disabled =
    !cloud || reading || busy || pending !== null;
  element<HTMLButtonElement>("retry-save").disabled = busy || !cloud;
  element<HTMLButtonElement>("discard-pending").disabled = busy;
  element<HTMLButtonElement>("generate-btn").disabled =
    busy ||
    generating ||
    pending !== null ||
    saved?.qr_data == null ||
    invalidTimestamp;
  element("generate-btn").querySelector("span")!.textContent = generating
    ? "Updating QR…"
    : "Refresh QR now";
  element<HTMLButtonElement>("copy-btn").disabled = !output;
  const download = element<HTMLAnchorElement>("download-btn");
  download.setAttribute("aria-disabled", String(!output));
  download.tabIndex = output ? 0 : -1;
  element("pending-actions").hidden = pending === null || busy;
}
function renderSource() {
  const data = pending?.qr_data ?? saved?.qr_data;
  element("source-empty").hidden = data != null;
  element("source-data").hidden = data == null;
  element("source-data").textContent = data ?? "";
  element("source-size").textContent =
    data == null
      ? ""
      : `${new TextEncoder().encode(data).length.toLocaleString()} bytes`;
  const badge = element("source-badge");
  badge.textContent =
    pending !== null
      ? "Not saved to cloud"
      : data != null
        ? "Saved to cloud"
        : "Awaiting first scan";
  badge.className = `small-badge ${pending !== null ? "pending" : data != null ? "saved" : ""}`;
  const meta = element("source-meta");
  meta.textContent =
    pending !== null
      ? "This scan is only on this device until the save succeeds."
      : saved?.updated_at
        ? `Cloud saved ${new Date(saved.updated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
        : "Your latest scan will be saved across devices.";
  meta.title = pending === null && saved?.updated_at ? saved.updated_at : "";
  updateButtons();
}
async function refresh(manual = false) {
  if (!cloud || reading || busy || pending !== null) return;
  reading = true;
  const version = dataVersion;
  updateButtons();
  if (manual) connection("Refreshing", "loading");
  try {
    const result = await cloud.read();
    if (version !== dataVersion) return;
    if (
      result.qr_data !== saved?.qr_data ||
      result.scanned_at !== saved?.scanned_at
    )
      invalidateOutput();
    saved = result;
    connection("Cloud connected", "connected");
    message("cloud-message");
    renderSource();
    tickClock();
  } catch (error) {
    if (version !== dataVersion) return;
    connection("Connection issue", "warning");
    message(
      "cloud-message",
      friendly(error) +
        (saved?.qr_data != null ? " The last loaded copy is shown." : ""),
      "error",
    );
  } finally {
    reading = false;
    updateButtons();
  }
}

async function savePending() {
  if (pending === null) return;
  if (!cloud) {
    message(
      "capture-message",
      "QR decoded. Connect Supabase using the setup guide before this scan can be saved.",
      "error",
    );
    renderSource();
    return;
  }
  busy = true;
  dataVersion++;
  updateButtons();
  connection("Saving to cloud", "loading");
  message("capture-message", "QR decoded. Saving to cloud…");
  try {
    const result = await cloud.save(pending);
    if (
      result.qr_data !== pending.qr_data ||
      result.scanned_at === null ||
      Date.parse(result.scanned_at) !== Date.parse(pending.scanned_at)
    )
      throw new Error("The cloud save could not be confirmed. Try Save again.");
    saved = result;
    pending = null;
    invalidateOutput();
    connection("Cloud connected", "connected");
    message(
      "capture-message",
      "Saved successfully. Your QR data is ready on any device.",
      "success",
    );
    message("cloud-message");
  } catch (error) {
    connection("Save unconfirmed", "warning");
    message("capture-message", friendly(error), "error");
  } finally {
    busy = false;
    renderSource();
    tickClock();
  }
}

async function acceptDecoded(
  text: string,
  scannedAt = new Date().toISOString(),
) {
  if (text.length === 0)
    throw new Error(
      "This QR code contains empty data. Please scan another QR code.",
    );
  if (text.includes("\0"))
    throw new Error(
      "This QR contains a null character, which the database cannot store. Choose another QR.",
    );
  if (new TextEncoder().encode(text).length > MAX_DATA_BYTES)
    throw new Error(
      "This QR contains too much text to store. The limit is 8 KB.",
    );
  pending = { qr_data: text, scanned_at: scannedAt };
  dataVersion++;
  invalidateOutput();
  renderSource();
  await savePending();
}

async function upload(file?: File) {
  if (!file || busy) return;
  busy = true;
  dataVersion++;
  updateButtons();
  message("capture-message", "Reading your QR image…");
  try {
    await acceptDecoded(await decodeImage(file));
  } catch (error) {
    message("capture-message", friendly(error), "error");
  } finally {
    busy = false;
    renderSource();
    tickClock();
    element<HTMLInputElement>("qr-file").value = "";
  }
}

element("qr-file").addEventListener("change", () => {
  void upload(element<HTMLInputElement>("qr-file").files?.[0]);
});
const drop = element("drop-zone");
for (const event of ["dragenter", "dragover"])
  drop.addEventListener(event, (e) => {
    e.preventDefault();
    if (!busy) drop.classList.add("drag-over");
  });
for (const event of ["dragleave", "drop"])
  drop.addEventListener(event, (e) => {
    e.preventDefault();
    drop.classList.remove("drag-over");
  });
drop.addEventListener("drop", (e) => {
  const files = (e as DragEvent).dataTransfer?.files;
  if (files && files.length > 1) {
    message("capture-message", "Choose one QR image at a time.", "error");
    return;
  }
  void upload(files?.[0]);
});
element("refresh-btn").addEventListener("click", () => {
  void refresh(true);
});
element("retry-save").addEventListener("click", () => {
  if (!busy) void savePending();
});
element("discard-pending").addEventListener("click", () => {
  if (busy) return;
  pending = null;
  dataVersion++;
  message("capture-message");
  invalidateOutput();
  renderSource();
  void refresh(true);
});

/** Recompute from the saved source and the current clock, never from the previous output. */
function updateLiveQr(now = new Date(), force = false): Promise<void> {
  if (saved?.qr_data == null || pending !== null || busy)
    return Promise.resolve();
  const source = saved.qr_data;
  const scannedAt = saved.scanned_at;
  if (failedSource === source && !force) return Promise.resolve();
  let live: ReturnType<typeof createLivePayload>;
  try {
    live = createLivePayload(source, scannedAt, now);
  } catch (error) {
    const previousMessage = element("output-message").textContent;
    if (!invalidTimestamp || output || generating) invalidateOutput();
    const future = error instanceof FutureScanTimeError;
    // A clock mismatch can resolve on the next tick without rescanning the QR.
    failedSource = future ? null : source;
    invalidTimestamp = true;
    element("qr-live-state").textContent = future
      ? "Saved scan time is ahead of this clock"
      : error instanceof MissingScanTimeError
        ? "Scan again to record the system time"
        : "Check the QR or saved scan time";
    if (error instanceof MissingScanTimeError) {
      element("baseline-timestamp").textContent = "Not recorded — scan again";
    }
    if (future) {
      element("baseline-timestamp").textContent = error.scannedAtLocal;
      element("original-timestamp").textContent =
        error.originalTimestamp ?? "—";
      element("original-time").textContent =
        error.originalTimestamp?.slice(11) ?? "—";
      element("baseline-interpretation").textContent = error.scannedAtIso;
      element("elapsed-duration").textContent = duration(error.elapsedMs);
      element("rounded-duration").textContent = "Waiting for clock";
      element("elapsed-calculation").textContent =
        "Current system time is before the saved scan time.";
    }
    if (previousMessage !== friendly(error))
      message("output-message", friendly(error), "error");
    updateButtons();
    return Promise.resolve();
  }
  invalidTimestamp = false;
  element("original-time").textContent = live.originalTime;
  element("current-time").textContent = live.currentTime;
  element("baseline-timestamp").textContent = live.scannedAtLocal;
  element("original-timestamp").textContent = live.originalTimestamp;
  element("baseline-interpretation").textContent = live.scannedAtIso;
  element("current-timestamp").textContent = live.currentTimestamp;
  element("elapsed-duration").textContent = duration(live.elapsedMs);
  element("rounded-duration").textContent = duration(
    live.roundedElapsedSeconds * 1000,
  );
  element("elapsed-calculation").textContent =
    `floor(${(live.elapsedMs / 1000).toFixed(3)} ÷ 15) × 15 = ${live.roundedElapsedSeconds} seconds`;
  element("qr-time").textContent = live.qrTime;
  element("next-update").textContent =
    `Next update in ${Math.ceil(live.nextUpdateMs / 1000)}s`;
  if (output?.text === live.text && !force) return Promise.resolve();
  if (generating && requestedText === live.text && !force)
    return generationTask ?? Promise.resolve();

  const version = ++generationVersion;
  generating = true;
  requestedText = live.text;
  failedSource = null;
  clearRenderedQr();
  element("qr-live-state").textContent = "Updating QR…";
  message("output-message");
  updateButtons();
  generationTask = (async () => {
    try {
      const png = await generateQr(live.text);
      if (
        version !== generationVersion ||
        source !== saved?.qr_data ||
        scannedAt !== saved?.scanned_at ||
        pending !== null
      )
        return;
      // A slow generation or suspended tab must not publish an expired interval.
      if (createLivePayload(source, scannedAt, new Date()).text !== live.text)
        return;
      output = { text: live.text, png };
      element<HTMLImageElement>("generated-qr").src = png;
      element("qr-placeholder").hidden = true;
      element("qr-result").hidden = false;
      element("combined-data").textContent = live.text;
      element("combined-data").classList.add("has-data");
      element("combined-size").textContent =
        `${new TextEncoder().encode(live.text).length.toLocaleString()} bytes`;
      element<HTMLAnchorElement>("download-btn").href = png;
      element("qr-live-state").textContent = "Live · updates every 15 seconds";
      message(
        "output-message",
        "Only the time changes. The date and all other QR text stay the same.",
        "success",
      );
    } catch (error) {
      if (version !== generationVersion) return;
      failedSource = error instanceof FutureScanTimeError ? null : source;
      element("qr-live-state").textContent = "QR update failed";
      element("next-update").textContent = "—";
      message("output-message", friendly(error), "error");
    } finally {
      if (version === generationVersion) {
        generating = false;
        generationTask = null;
        updateButtons();
      }
    }
  })();
  return generationTask;
}

// Checking the wall clock on second boundaries also drives the visible countdown.
// QR images are generated only when the anchored 15-second slot actually changes.
function tickClock() {
  if (clockTimer !== null) clearTimeout(clockTimer);
  clockTimer = null;
  if (document.hidden) return;
  const now = new Date();
  element("current-timestamp").textContent = localTimestamp(now);
  element("current-time").textContent = [
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  element("clock-timezone").textContent =
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  void updateLiveQr(now);
  let delay = 1000 - now.getMilliseconds();
  if (saved?.scanned_at && pending === null && !busy) {
    const elapsed = now.getTime() - Date.parse(saved.scanned_at);
    if (Number.isFinite(elapsed)) {
      delay = Math.min(
        delay,
        elapsed < 0 ? -elapsed : 15000 - (elapsed % 15000),
      );
    }
  }
  clockTimer = setTimeout(tickClock, Math.max(1, delay));
}

element("generate-btn").addEventListener("click", () => {
  void updateLiveQr(new Date(), true);
});
element("download-btn").addEventListener("click", async (event) => {
  event.preventDefault();
  await updateLiveQr();
  if (!output) return;
  const link = document.createElement("a");
  link.href = output.png;
  link.download = "live-qr.png";
  document.body.appendChild(link);
  link.click();
  link.remove();
});
element("copy-btn").addEventListener("click", async () => {
  await updateLiveQr();
  if (!output) return;
  const text = output.text;
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    message(
      "output-message",
      "Current QR text copied to clipboard.",
      "success",
    );
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element("combined-data"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    message(
      "output-message",
      "Clipboard access is unavailable. The current QR text is selected; copy it using your device’s copy command.",
      "info",
    );
  }
});

const cameraDialog = element<HTMLDialogElement>("camera-dialog");
const scanner = new CameraScanner(
  element<HTMLVideoElement>("camera-video"),
  (text) => {
    const scannedAt = new Date().toISOString();
    closeCamera();
    void acceptDecoded(text, scannedAt).catch((error) => {
      message("capture-message", friendly(error), "error");
      busy = false;
      updateButtons();
    });
  },
  (error) => {
    element("camera-message").textContent = error;
    message("capture-message", error, "error");
  },
);
function closeCamera() {
  scanner.stop();
  if (cameraDialog.open) cameraDialog.close();
}
element("scan-btn").addEventListener("click", async () => {
  if (busy) return;
  element("camera-message").textContent =
    "Keep the full QR code inside the frame.";
  cameraDialog.showModal();
  await scanner.start();
});
element("close-camera").addEventListener("click", closeCamera);
element("cancel-camera").addEventListener("click", closeCamera);
cameraDialog.addEventListener("close", () => scanner.stop());
cameraDialog.addEventListener("cancel", () => scanner.stop());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) closeCamera();
  else void refresh();
  tickClock();
});
window.addEventListener("pagehide", () => {
  closeCamera();
  if (clockTimer !== null) clearTimeout(clockTimer);
  clockTimer = null;
});
window.addEventListener("pageshow", tickClock);
window.addEventListener("focus", () => {
  tickClock();
  void refresh();
});
window.addEventListener("online", () => {
  void refresh();
});
window.addEventListener("offline", () => {
  connection("Offline", "warning");
});
setInterval(() => {
  if (!document.hidden) void refresh();
}, 30000);

renderSource();
tickClock();
if (cloud) void refresh();
else {
  element("setup-banner").hidden = false;
  connection("Setup needed", "warning");
}
