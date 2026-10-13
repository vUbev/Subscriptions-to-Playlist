/*
 * Auto-add. Does nothing unless the current page is /feed/subscriptions. On that
 * page it looks at the videos shown, finds the ones from your listed channels
 * (skipping ones you've already watched), and adds any that aren't in your
 * playlist yet.
 */
(() => {
  "use strict";

  const FEED_PATH = "/feed/subscriptions";
  const MAX_HANDLED = 5000;

  const failedThisPage = new Set(); // don't hammer a video that errored; retried on reload / settings change
  const dryRunReported = new Set();
  const skippedReported = new Set();
  let running = false;
  let rescan = false;
  let timer = null;

  const isFeedPage = () => location.pathname.replace(/\/+$/, "") === FEED_PATH;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function rememberHandled(ids) {
    const { handled } = await browser.storage.local.get({ handled: [] });
    const merged = Array.from(new Set(handled.concat(ids))).slice(-MAX_HANDLED);
    await browser.storage.local.set({ handled: merged });
  }

  async function scanOnce() {
    if (!isFeedPage()) return;
    const cfg = await browser.storage.local.get(SUBS_DEFAULTS);
    if (!cfg.enabled || !isFeedPage()) return;

    const playlistId = parsePlaylistId(cfg.playlistUrl);
    const entries = cfg.channels.map(parseChannelEntry).filter(Boolean);
    if (!playlistId || entries.length === 0) return;

    const minWatched = Math.max(1, Number(cfg.watchedMinPercent) || 1);
    const label = (v) => `"${v.title}" (${v.channel.name || v.channel.handle || "unknown channel"})`;

    const handled = new Set(cfg.handled);
    const candidates = new Map();
    for (const el of document.querySelectorAll(SUBS_CARD_SELECTOR)) {
      const v = extractVideo(el);
      if (!v) continue;
      if (handled.has(v.videoId) || failedThisPage.has(v.videoId) || candidates.has(v.videoId)) continue;
      if (!channelMatches(entries, v.channel)) continue;
      if (cfg.skipWatched && v.watchedPercent > 0 && v.watchedPercent >= minWatched) {
        if (!skippedReported.has(v.videoId)) {
          skippedReported.add(v.videoId);
          addLog("info", `Skipped (already watched ${Math.round(v.watchedPercent)}%): ${label(v)}`);
        }
        continue;
      }
      candidates.set(v.videoId, v);
    }
    if (candidates.size === 0) return;

    if (cfg.dryRun) {
      for (const v of candidates.values()) {
        if (dryRunReported.has(v.videoId)) continue;
        dryRunReported.add(v.videoId);
        addLog("info", `[dry run] would add ${label(v)}`);
      }
      return;
    }

    let inPlaylist;
    try {
      inPlaylist = await fetchPlaylistVideoIds(playlistId, new Set(candidates.keys()));
    } catch (err) {
      for (const id of candidates.keys()) failedThisPage.add(id);
      addLog("error", `Couldn't read the playlist: ${err.message}`);
      return;
    }

    const done = [];
    for (const v of candidates.values()) {
      if (inPlaylist.has(v.videoId)) {
        done.push(v.videoId);
        addLog("info", `Already in playlist: ${label(v)}`);
        continue;
      }
      try {
        await addToPlaylist(playlistId, v.videoId);
        done.push(v.videoId);
        addLog("ok", `Added ${label(v)}`);
      } catch (err) {
        failedThisPage.add(v.videoId);
        addLog("error", `Couldn't add ${label(v)}: ${err.message}`);
      }
      await sleep(500);
    }
    if (done.length) await rememberHandled(done);
  }

  async function scan() {
    if (running) {
      rescan = true;
      return;
    }
    running = true;
    try {
      do {
        rescan = false;
        await scanOnce();
      } while (rescan);
    } catch (err) {
      addLog("error", `Unexpected error: ${err && err.message ? err.message : err}`);
    } finally {
      running = false;
    }
  }

  function schedule(delay) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, delay);
  }

  // YouTube is a single-page app: new videos appear without page loads, so watch the DOM.
  new MutationObserver(() => {
    if (isFeedPage()) schedule(1000);
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("yt-navigate-finish", () => schedule(1500));

  browser.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes.enabled || changes.dryRun || changes.playlistUrl || changes.channels || changes.skipWatched || changes.watchedMinPercent)
    ) {
      failedThisPage.clear();
      schedule(300);
    }
  });

  schedule(1500);
})();
