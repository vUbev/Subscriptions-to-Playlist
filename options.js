"use strict";

const $ = (id) => document.getElementById(id);
const SAVE_DELAY_MS = 400;

let statusTimer = null;
function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text;
  el.className = isError ? "error" : "";
  clearTimeout(statusTimer);
  if (!isError && text) statusTimer = setTimeout(() => (el.textContent = ""), 2500);
}

async function saveValues(values, message) {
  try {
    await browser.storage.local.set(values);
    setStatus(message || "Saved", false);
  } catch (err) {
    setStatus(`Couldn't save: ${err && err.message ? err.message : err}`, true);
  }
}

function renderLog(entries) {
  const ul = $("log");
  ul.textContent = "";
  if (!entries.length) {
    const li = document.createElement("li");
    li.textContent = "Nothing yet. Open youtube.com/feed/subscriptions and activity will show up here.";
    ul.append(li);
    return;
  }
  for (const e of entries.slice().reverse().slice(0, 50)) {
    const li = document.createElement("li");
    li.className = e.level;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date(e.t).toLocaleString();
    const msg = document.createElement("span");
    msg.textContent = e.msg; // textContent: video titles come from the web page, never treat them as HTML
    li.append(time, msg);
    ul.append(li);
  }
}

async function load() {
  const cfg = await browser.storage.local.get(SUBS_DEFAULTS);
  $("enabled").checked = cfg.enabled;
  $("dryRun").checked = cfg.dryRun;
  $("skipWatched").checked = cfg.skipWatched;
  $("watchedMin").value = cfg.watchedMinPercent;
  $("showButton").checked = cfg.showButton;
  $("playlist").value = cfg.playlistUrl;
  $("channels").value = cfg.channels.join("\n");
  renderLog(cfg.log);
  $("handledCount").textContent = cfg.handled.length;
}

// ---------- autosave: each field saves only itself, shortly after you change it ----------

for (const key of ["enabled", "dryRun", "skipWatched", "showButton"]) {
  $(key).addEventListener("change", () => saveValues({ [key]: $(key).checked }));
}

function saveWatchedMin() {
  const n = Math.min(100, Math.max(1, Math.round(Number($("watchedMin").value) || 1)));
  return saveValues({ watchedMinPercent: n });
}

function savePlaylist() {
  const url = $("playlist").value.trim();
  if (!parsePlaylistId(url)) {
    setStatus("That doesn't look like a playlist URL (it needs ?list=…). Not saved yet.", true);
    return Promise.resolve();
  }
  return saveValues({ playlistUrl: url });
}

function saveChannels() {
  const channels = $("channels")
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean); // comment lines (# …) are kept; they're ignored when matching
  const count = channels.filter((s) => !s.startsWith("#")).length;
  return saveValues({ channels }, `Saved. Watching ${count} channel${count === 1 ? "" : "s"}.`);
}

function autosaveText(id, save) {
  let timer = null;
  $(id).addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  });
  $(id).addEventListener("change", () => {
    clearTimeout(timer);
    save();
  });
}
autosaveText("watchedMin", saveWatchedMin);
autosaveText("playlist", savePlaylist);
autosaveText("channels", saveChannels);

$("clearLog").addEventListener("click", async () => {
  await browser.storage.local.set({ log: [] });
});

$("forget").addEventListener("click", async () => {
  if (
    confirm(
      "Forget which videos have been handled?\n\nVideos you've since removed from the playlist will be added again the next time they appear on your feed."
    )
  ) {
    await browser.storage.local.set({ handled: [] });
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.log) renderLog(changes.log.newValue || []);
  if (changes.handled) $("handledCount").textContent = (changes.handled.newValue || []).length;
  // The hover button on YouTube edits the channel list too; keep this page in step unless you're typing in it.
  if (changes.channels && document.activeElement !== $("channels")) {
    $("channels").value = (changes.channels.newValue || []).join("\n");
  }
});

load();
