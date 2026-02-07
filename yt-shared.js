/* ========= YouTube Shared Data Layer =========
   - Single source of truth for both iframes
   - One fetch per page view, 30-minute localStorage cache
   - BroadcastChannel + storage-event coordination
   -----------------------------------------------
   HOW TO USE:
   1) Set your API key below.
   2) Set the playlist
   3) In your iframes, call: YTShared.getSharedData().then(data => ...)
*/

(() => {
  /* ======= CONFIG ======= */
  const API_KEY     = "AIzaSyDvflaf2WrXoTPnj1-cDHYWhCD_pMJnhoY"; 
  const PLAYLIST_ID = "PLchy_nZQAZtAIkcBQ3sMEQgLfoF48-FiV";

  const CACHE_KEY   = "yt_data_v1";
  const LOCK_KEY    = "yt_fetch_lock_v1";
  const CACHE_MS    = 30 * 60 * 1000;  // 30 minutes
  const LOCK_MS     = 45 * 1000;       // guard against stuck locks

  /* ======= Channel ======= */
  let bc = null;
  try { bc = new BroadcastChannel('yt-events-v1'); } catch (_) {}
  let inflightPromise = null;
  const waiters = [];

  function now() { return Date.now(); }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.timestamp || !obj.data) return null;
      if ((now() - obj.timestamp) > CACHE_MS) return null;
      return obj.data;
    } catch { return null; }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: now(), data }));
      // Inform siblings (BroadcastChannel and storage event fallback)
      if (bc) { try { bc.postMessage({ type: 'yt-response', payload: data }); } catch {} }
    } catch {}
  }

  function getLockOwner() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      if (!raw) return null;
      const { ts, id } = JSON.parse(raw);
      if (!ts || !id) return null;
      if (now() - ts > LOCK_MS) return null; // stale
      return { ts, id };
    } catch { return null; }
  }

  function tryAcquireLock(id) {
    const holder = getLockOwner();
    if (holder) return false;
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ ts: now(), id }));
      const check = getLockOwner();
      return check && check.id === id;
    } catch { return false; }
  }

  function releaseLock(id) {
    try {
      const holder = getLockOwner();
      if (holder && holder.id === id) localStorage.removeItem(LOCK_KEY);
    } catch {}
  }

  async function fetchFromYouTube() {
    // 1) playlistItems
    const plURL = "https://www.googleapis.com/youtube/v3/playlistItems"
      + `?part=snippet,contentDetails&playlistId=${PLAYLIST_ID}&maxResults=50&key=${API_KEY}`;
    const plRes = await fetch(plURL);
    const plData = await plRes.json();
    const ids = (plData.items || [])
      .map(i => i.contentDetails && i.contentDetails.videoId)
      .filter(Boolean);

    if (!ids.length) return { next: null, upcoming: [], past: [] };

    // 2) videos (details + live info)
    const vidURL = "https://www.googleapis.com/youtube/v3/videos"
      + `?part=snippet,liveStreamingDetails,status&id=${ids.join(",")}&key=${API_KEY}`;
    const vidRes = await fetch(vidURL);
    const vidData = await vidRes.json();

    const items = (vidData.items || [])
      .filter(v => v.status?.privacyStatus === "public")
      .map(v => ({
        id: v.id,
        title: v.snippet.title,
        description: v.snippet.description || "",
        thumbnails: v.snippet.thumbnails || {},
        scheduledStartTime: v.liveStreamingDetails?.scheduledStartTime || null,
        actualStartTime:    v.liveStreamingDetails?.actualStartTime    || null,
        actualEndTime:      v.liveStreamingDetails?.actualEndTime      || null,
      }));

    const nowTs = Date.now();

    const upcoming = items
      .filter(v => v.scheduledStartTime && new Date(v.scheduledStartTime).getTime() >= nowTs)
      .sort((a,b) => new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime));

    const past = items
      .filter(v =>
        (v.actualStartTime && new Date(v.actualStartTime).getTime() < nowTs) ||
        v.actualEndTime
      )
      .sort((a,b) => {
        const aDate = new Date(a.actualStartTime || a.scheduledStartTime);
        const bDate = new Date(b.actualStartTime || b.scheduledStartTime);
        return bDate - aDate;
      });

    const next = upcoming[0] || past[past.length - 1] || null;

    return { next, upcoming, past };
  }

  function resolveAll(data) {
    while (waiters.length) {
      const resolve = waiters.shift();
      try { resolve(data); } catch {}
    }
  }

  // Broadcast listeners
  if (bc) {
    bc.onmessage = (ev) => {
      const msg = ev && ev.data || {};
      if (msg.type === 'yt-request') {
        const c = readCache();
        if (c) { try { bc.postMessage({ type: 'yt-response', payload: c }); } catch {} }
      } else if (msg.type === 'yt-response' && msg.payload) {
        // update local cache timestamp and wake waiters
        writeCache(msg.payload);
        resolveAll(msg.payload);
      }
    };
  }

  // Storage-event fallback (fires in sibling documents)
  window.addEventListener('storage', (e) => {
    if (e.key === CACHE_KEY && e.newValue) {
      try {
        const obj = JSON.parse(e.newValue);
        if (obj && obj.data) resolveAll(obj.data);
      } catch {}
    }
  });

  async function startFetchWithLock() {
    const myId = Math.random().toString(36).slice(2);
    const won = tryAcquireLock(myId);
    if (!won) return null;

    inflightPromise = (async () => {
      try {
        const data = await fetchFromYouTube();
        writeCache(data);        // also broadcasts
        resolveAll(data);
        return data;
      } finally {
        releaseLock(myId);
        inflightPromise = null;
      }
    })();

    return inflightPromise;
  }

  async function getSharedData() {
    // 1) Cached?
    const cached = readCache();
    if (cached) return cached;

    // 2) Somebody already fetching?
    if (inflightPromise) return inflightPromise;

    // 3) Ask siblings first (if any)
    if (bc) { try { bc.postMessage({ type: 'yt-request' }); } catch {} }

    // 4) Create a waiter and a short fallback
    const waitP = new Promise((resolve) => waiters.push(resolve));

    // Short fallback: if no response in ~1.2s, try to fetch with lock
    setTimeout(async () => {
      const c = readCache();
      if (c) { resolveAll(c); return; }
      if (!inflightPromise) {
        const p = await startFetchWithLock();
        if (!p) {
          // Couldn't get lock; try again after 3s if still nothing
          setTimeout(async () => {
            const c2 = readCache();
            if (c2) { resolveAll(c2); return; }
            if (!inflightPromise) { await startFetchWithLock(); }
          }, 3000);
        }
      }
    }, 1200);

    return waitP;
  }

  // Expose
  window.YTShared = { getSharedData };
})();
