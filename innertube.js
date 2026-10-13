/*
 * Talks to YouTube's own web endpoints (the same ones the site uses) with your
 * logged-in session, so there are no API keys or OAuth to set up.
 * Loaded before content.js and button.js, which share these functions.
 */
"use strict";

var INNERTUBE_FALLBACK_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // YouTube web client's public key
var INNERTUBE_MAX_PLAYLIST_PAGES = 60;
var INNERTUBE_MAX_SUBSCRIPTION_PAGES = 40;
var innertubeConfigCache = null;

function getInnertubeConfig() {
  if (innertubeConfigCache) return innertubeConfigCache;
  let apiKey, clientVersion, authUser;

  try {
    const yt = window.wrappedJSObject && window.wrappedJSObject.ytcfg;
    if (yt && typeof yt.get === "function") {
      apiKey = yt.get("INNERTUBE_API_KEY");
      clientVersion = yt.get("INNERTUBE_CLIENT_VERSION");
      authUser = yt.get("SESSION_INDEX");
    }
  } catch (_) {
    /* fall through to scraping */
  }

  if (!apiKey || !clientVersion || authUser == null) {
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t) continue;
      let m;
      if (!apiKey && (m = t.match(/"INNERTUBE_API_KEY":"([^"]+)"/))) apiKey = m[1];
      if (!clientVersion && (m = t.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/))) clientVersion = m[1];
      if (authUser == null && (m = t.match(/"SESSION_INDEX":"?(\d+)/))) authUser = m[1];
      if (apiKey && clientVersion && authUser != null) break;
    }
  }

  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  innertubeConfigCache = {
    apiKey: apiKey || INNERTUBE_FALLBACK_API_KEY,
    clientVersion: clientVersion || `2.${stamp}.00.00`,
    authUser: String(authUser != null ? authUser : 0),
  };
  return innertubeConfigCache;
}

function getCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? m[1] : null;
}

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function authHeader() {
  const sapisid = getCookie("SAPISID") || getCookie("__Secure-3PAPISID");
  if (!sapisid) throw new Error("you don't appear to be signed in to YouTube");
  const ts = Math.floor(Date.now() / 1000);
  const hash = await sha1Hex(`${ts} ${sapisid} ${location.origin}`);
  return `SAPISIDHASH ${ts}_${hash}`;
}

async function innertube(endpoint, body) {
  const cfg = getInnertubeConfig();
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(cfg.apiKey)}&prettyPrint=false`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authHeader(),
        "X-Goog-AuthUser": cfg.authUser,
        "X-Origin": location.origin,
        "X-Youtube-Client-Name": "1",
        "X-Youtube-Client-Version": cfg.clientVersion,
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: cfg.clientVersion, hl: "en", gl: "US" } },
        ...body,
      }),
    }
  );
  if (!res.ok) {
    const err = new Error(
      res.status === 401 || res.status === 403
        ? `YouTube refused the request (HTTP ${res.status}); make sure you're signed in`
        : `YouTube returned HTTP ${res.status}`
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Walks a browse response collecting playlist video IDs and the next continuation token. */
function collectPlaylistPage(root) {
  const ids = [];
  let token = null;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      for (const x of n) stack.push(x);
      continue;
    }
    if (n.playlistVideoRenderer && n.playlistVideoRenderer.videoId) {
      ids.push(n.playlistVideoRenderer.videoId);
    }
    const lvm = n.lockupViewModel;
    if (lvm && lvm.contentId && lvm.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      ids.push(lvm.contentId);
    }
    const t =
      n.continuationItemRenderer &&
      n.continuationItemRenderer.continuationEndpoint &&
      n.continuationItemRenderer.continuationEndpoint.continuationCommand &&
      n.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (t) token = t;
    for (const k in n) stack.push(n[k]);
  }
  return { ids, token };
}

/** Reads the playlist (page by page) until every wanted ID is found or the end is reached. */
async function fetchPlaylistVideoIds(playlistId, wanted) {
  const found = new Set();
  let data = await innertube("browse", { browseId: "VL" + playlistId });
  for (let page = 0; page < INNERTUBE_MAX_PLAYLIST_PAGES; page++) {
    const { ids, token } = collectPlaylistPage(data);
    ids.forEach((id) => found.add(id));
    if (!token) break;
    if (Array.from(wanted).every((id) => found.has(id))) break;
    data = await innertube("browse", { continuation: token });
  }
  return found;
}

async function addToPlaylist(playlistId, videoId) {
  const send = (action) => innertube("browse/edit_playlist", { playlistId, actions: [action] });
  let data;
  try {
    data = await send({ action: "ACTION_ADD_VIDEO", addedVideoId: videoId, dedupeOption: "DEDUPE_OPTION_SKIP" });
  } catch (err) {
    if (err.status !== 400) throw err;
    data = await send({ action: "ACTION_ADD_VIDEO", addedVideoId: videoId }); // retry without the dedupe hint
  }
  if (!data || data.status !== "STATUS_SUCCEEDED") {
    throw new Error("unexpected response: " + JSON.stringify(data).slice(0, 160));
  }
}

/**
 * Loads the channels you're subscribed to ("All subscriptions" page).
 * `complete` is only true if the whole list was read and recognised, so callers
 * never treat a partial or unparseable result as "you aren't subscribed".
 */
async function fetchSubscriptions() {
  const acc = { ids: new Set(), handles: new Set(), alts: new Set(), names: new Set() };
  let finished = false;
  let data = await innertube("browse", { browseId: "FEchannels" });
  for (let page = 0; page < INNERTUBE_MAX_SUBSCRIPTION_PAGES; page++) {
    const { items, token } = collectSubscriptions(data);
    for (const it of items) {
      acc.ids.add(it.id);
      if (it.handle) acc.handles.add(it.handle);
      if (it.alt) acc.alts.add(it.alt);
      if (it.name) acc.names.add(it.name);
    }
    if (!token) {
      finished = true;
      break;
    }
    data = await innertube("browse", { continuation: token });
  }
  return {
    fetchedAt: Date.now(),
    complete: finished && acc.ids.size > 0,
    ids: Array.from(acc.ids),
    handles: Array.from(acc.handles),
    alts: Array.from(acc.alts),
    names: Array.from(acc.names),
  };
}
