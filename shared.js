/* Shared by the content scripts, the options page and the tests. */
"use strict";

var SUBS_DEFAULTS = {
  enabled: true,
  dryRun: false,
  skipWatched: true,
  watchedMinPercent: 1, // count a video as watched once at least this much of it is
  showButton: true,
  playlistUrl: "https://www.youtube.com/playlist?list=WL", // Watch Later
  channels: [],
  handled: [], // video IDs we've already dealt with (added, or found in the playlist)
  log: [],
};

/** Elements that represent one video "card" across YouTube's various layouts. */
var SUBS_CARD_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-grid-video-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "yt-lockup-view-model",
].join(",");

// Text that starts with a duration ("37:08") is the length badge, not a title.
var SUBS_DURATION_RE = /^\d{1,2}(:\d{2}){1,2}(\s|$)/;

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** Accepts a playlist URL (…?list=PL…) or a bare playlist ID. Returns the ID or null. */
function parsePlaylistId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  try {
    const id = new URL(s).searchParams.get("list");
    if (id) return id;
  } catch (_) {
    /* not a URL */
  }
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

/**
 * One line from the channel list. Accepts a display name, an @handle,
 * a channel URL (/@handle, /channel/UC…, /c/…, /user/…) or a bare UC… channel ID.
 */
function parseChannelEntry(raw) {
  const s = (raw || "").trim();
  if (!s || s.startsWith("#")) return null;

  const m = s.match(/youtube\.com\/(?:(@[^\/?#\s]+)|channel\/(UC[\w-]{22})|(?:c|user)\/([^\/?#\s]+))/i);
  if (m) {
    if (m[2]) return { type: "id", value: m[2] };
    if (m[1]) return { type: "handle", value: safeDecode(m[1].slice(1)).toLowerCase() };
    return { type: "name", value: safeDecode(m[3]).toLowerCase() };
  }
  if (/^UC[\w-]{22}$/.test(s)) return { type: "id", value: s };
  if (s.startsWith("@")) return { type: "handle", value: safeDecode(s.slice(1)).toLowerCase() };
  return { type: "name", value: s.replace(/\s+/g, " ").toLowerCase() };
}

/** channel = { id, handle, alt, name } as read from a video card. */
function channelMatches(entries, channel) {
  const name = cleanText(channel.name).toLowerCase();
  for (const e of entries) {
    if (e.type === "id") {
      if (channel.id && channel.id === e.value) return true;
    } else if (e.type === "handle") {
      if (channel.handle && channel.handle === e.value) return true;
    } else if (e.type === "name") {
      // A plain word like "penguinz0" matches the display name, the @handle or a legacy /c/ name.
      if (name && name === e.value) return true;
      if (channel.handle && channel.handle === e.value) return true;
      if (channel.alt && channel.alt === e.value) return true;
    }
  }
  return false;
}

/** Reads the channel shown on a video card from its links to channel pages. */
function extractChannel(el) {
  const channel = { id: null, handle: null, handleRaw: null, alt: null, altRaw: null, name: "" };
  for (const a of el.querySelectorAll("a[href]")) {
    let path;
    try {
      path = new URL(a.getAttribute("href"), "https://www.youtube.com").pathname;
    } catch (_) {
      continue;
    }
    let m;
    if ((m = path.match(/^\/@([^\/]+)/))) {
      if (!channel.handle) {
        channel.handleRaw = safeDecode(m[1]);
        channel.handle = channel.handleRaw.toLowerCase();
      }
    } else if ((m = path.match(/^\/channel\/(UC[\w-]{22})/))) {
      if (!channel.id) channel.id = m[1];
    } else if ((m = path.match(/^\/(?:c|user)\/([^\/]+)/))) {
      if (!channel.alt) {
        channel.altRaw = safeDecode(m[1]);
        channel.alt = channel.altRaw.toLowerCase();
      }
    } else {
      continue;
    }
    const text = cleanText(a.textContent);
    if (!channel.name && text) channel.name = text;
  }
  if (!channel.name) {
    const cn = el.querySelector("ytd-channel-name");
    if (cn) channel.name = cleanText(cn.textContent);
  }
  return channel;
}

/** The video's title: prefer real title elements, never the duration badge. */
function pickTitle(el, watchLinks) {
  const direct = el.querySelector(
    '#video-title, h3[title], h3 a[href*="/watch"], a[class*="lockup-metadata-view-model"][class*="title"]'
  );
  const nodes = direct ? [direct].concat(watchLinks) : watchLinks;
  for (const node of nodes) {
    const t = cleanText(node.getAttribute("title") || node.textContent);
    if (t && !SUBS_DURATION_RE.test(t)) return t;
  }
  return "";
}

/**
 * How much of the video YouTube says you've watched (0-100), read from the
 * progress bar drawn on the thumbnail. 0 means no bar is shown.
 */
function watchProgress(el) {
  const bars = el.querySelectorAll(
    'ytd-thumbnail-overlay-resume-playback-renderer #progress, [class*="WatchedProgressBarSegment"]'
  );
  if (bars.length === 0) return 0;
  let best = 0;
  let known = false;
  for (const b of bars) {
    const w = parseFloat((b.style && b.style.width) || "");
    if (!isNaN(w)) {
      known = true;
      best = Math.max(best, w);
    }
  }
  return known ? Math.min(best, 100) : 100; // a bar with no readable width: assume fully watched
}

/**
 * Pulls the video ID, title, channel and watch progress out of one video card.
 * Only relies on links to /watch?v=… and links to channel pages. Shorts are ignored.
 */
function extractVideo(el) {
  const watchLinks = Array.from(el.querySelectorAll('a[href*="/watch?v="]'));
  if (watchLinks.length === 0) return null;

  const idMatch = watchLinks[0].getAttribute("href").match(/[?&]v=([\w-]{11})/);
  if (!idMatch) return null;
  const videoId = idMatch[1];

  return {
    videoId,
    title: pickTitle(el, watchLinks).slice(0, 100) || videoId,
    channel: extractChannel(el),
    watchedPercent: watchProgress(el),
  };
}

/** The line to store in the channel list for a channel seen on a card. */
function channelEntryFor(ch) {
  if (ch.handleRaw) return "@" + ch.handleRaw;
  if (ch.id) return ch.id;
  if (ch.altRaw) return ch.altRaw;
  return ch.name || null;
}

/**
 * Adds the channel to the list, or removes every line that matches it if it's already there.
 * Returns { channels, added, removed? } or null if the channel can't be identified.
 */
function toggleChannel(channels, ch) {
  const kept = [];
  let removed = 0;
  for (const line of channels) {
    const e = parseChannelEntry(line);
    if (e && channelMatches([e], ch)) removed++;
    else kept.push(line);
  }
  if (removed) return { channels: kept, added: false, removed };
  const line = channelEntryFor(ch);
  if (!line) return null;
  return { channels: kept.concat(line), added: true };
}

/** Reads channels (and a continuation token) out of a "your subscriptions" browse response. */
function collectSubscriptions(root) {
  const items = [];
  let token = null;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      for (const x of n) stack.push(x);
      continue;
    }
    const cr = n.channelRenderer || n.gridChannelRenderer;
    if (cr && typeof cr === "object" && cr.channelId) {
      const be = cr.navigationEndpoint && cr.navigationEndpoint.browseEndpoint;
      const base = (be && be.canonicalBaseUrl) || "";
      let handle = null;
      let alt = null;
      let m;
      if ((m = base.match(/^\/@([^\/]+)/))) handle = safeDecode(m[1]).toLowerCase();
      else if ((m = base.match(/^\/(?:c|user)\/([^\/]+)/))) alt = safeDecode(m[1]).toLowerCase();
      const title = cr.title;
      const name = title ? title.simpleText || (title.runs || []).map((r) => r.text).join("") : "";
      items.push({ id: cr.channelId, handle, alt, name: cleanText(name).toLowerCase() });
    }
    const cont =
      n.continuationItemRenderer &&
      n.continuationItemRenderer.continuationEndpoint &&
      n.continuationItemRenderer.continuationEndpoint.continuationCommand &&
      n.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (cont) token = cont;
    for (const k in n) stack.push(n[k]);
  }
  return { items, token };
}

/**
 * subs = { complete, ids[], handles[], alts[], names[] }.
 * Returns true / false, or null when we can't tell (list missing or incomplete),
 * so a failed lookup never produces a false "not subscribed" warning.
 */
function isSubscribed(subs, ch) {
  if (!subs || !subs.complete) return null;
  if (ch.id && subs.ids.includes(ch.id)) return true;
  if (ch.handle && subs.handles.includes(ch.handle)) return true;
  if (ch.alt && (subs.alts.includes(ch.alt) || subs.handles.includes(ch.alt))) return true;
  const name = cleanText(ch.name).toLowerCase();
  if (name && subs.names.includes(name)) return true;
  if (!ch.id && !ch.handle && !ch.alt && !name) return null;
  return false;
}

// ---------- activity log (shown on the settings page) ----------

var subsLogChain = Promise.resolve();
function addLog(level, msg) {
  (level === "error" ? console.error : console.log)("[Subs→Playlist]", msg);
  subsLogChain = subsLogChain
    .then(async () => {
      const { log } = await browser.storage.local.get({ log: [] });
      log.push({ t: Date.now(), level, msg });
      await browser.storage.local.set({ log: log.slice(-100) });
    })
    .catch(() => {});
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SUBS_DEFAULTS,
    SUBS_CARD_SELECTOR,
    parsePlaylistId,
    parseChannelEntry,
    channelMatches,
    extractChannel,
    extractVideo,
    watchProgress,
    channelEntryFor,
    toggleChannel,
    collectSubscriptions,
    isSubscribed,
  };
}
