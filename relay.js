/*
  relay.js — the shared "walkie-talkie" used by BOTH the TV app and the phone page.
  (The same file sits in both folders. If you change one, copy it to the other.)

  What it does, in plain words:
    1. Both devices join the same "room" on Supabase Realtime (a live message channel).
    2. The phone cuts the photo into small text pieces and sends them one by one.
    3. The TV collects the pieces, glues them back together, and says "got it".
    4. If a piece goes missing, the TV asks for just that piece again.

  Nothing is stored online. Messages pass through and are gone.

  THINGS YOU CAN SAFELY CHANGE are marked with  <-- TWEAK
*/
(function (global) {
  "use strict";

  var PIECE_SIZE = 96000;        // <-- TWEAK  characters per piece. Supabase's free limit is ~256,000 per message, so stay well under.
  var STALL_MS = 2000;           // <-- TWEAK  how long the TV waits for a missing piece before asking again
  var MAX_ASKS = 5;              //            how many times the TV asks before giving up on a photo
  var CONFIRM_TIMEOUT_MS = 15000;// <-- TWEAK  how long the phone waits for the TV's "got it"
  var ROOM_PREFIX = "tvdrop-";

  // ---------- small helpers ----------

  // Random code with no look-alike characters (no 0/O, 1/I/L).
  function makeRoomCode(length) {
    var alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var out = "";
    var bytes = new Uint8Array(length || 10);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  // The link hidden inside the QR code. Everything after the # stays on the phone:
  // browsers never send that part to the web server.
  function buildPhoneLink(pageUrl, supabaseUrl, supabaseKey, room) {
    return pageUrl.replace(/#.*$/, "") +
      "#u=" + encodeURIComponent(supabaseUrl) +
      "&k=" + encodeURIComponent(supabaseKey) +
      "&r=" + encodeURIComponent(room);
  }

  // Reads that link back on the phone. Returns null if anything is missing.
  function readPhoneLink(hash) {
    var out = {};
    String(hash || "").replace(/^#/, "").split("&").forEach(function (pair) {
      var i = pair.indexOf("=");
      if (i > 0) out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    });
    if (!out.u || !out.k || !out.r) return null;
    return { supabaseUrl: out.u, supabaseKey: out.k, room: out.r };
  }

  function splitIntoPieces(text, size) {
    var pieces = [];
    for (var i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    return pieces;
  }

  function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  // ---------- joining a room ----------
  /*
    join({ supabaseUrl, supabaseKey, room, onStatus })
      onStatus(state) is called with "connected", "reconnecting" or "error".
    Gives back a "room" object:  room.on(eventName, fn)   room.send(eventName, data)   room.leave()
  */
  function join(options) {
    var listeners = {};
    var EVENTS = ["hello", "ready", "photo-start", "photo-piece", "photo-need", "photo-done"];

    var client = global.supabase.createClient(options.supabaseUrl, options.supabaseKey, {
      // We don't use logins, so switch all of that off.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    var channel = client.channel(ROOM_PREFIX + options.room, {
      config: { broadcast: { self: false, ack: true } }  // ack: the server confirms each message it accepts
    });

    EVENTS.forEach(function (name) {
      channel.on("broadcast", { event: name }, function (message) {
        (listeners[name] || []).forEach(function (fn) {
          try { fn(message.payload || {}); } catch (err) { console.error("[tvdrop] listener failed", err); }
        });
      });
    });

    var room = {
      on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
      // Sends one message; tries up to 3 times before giving up.
      send: function (name, data) {
        var attempt = 0;
        function tryOnce() {
          attempt++;
          return Promise.resolve(channel.send({ type: "broadcast", event: name, payload: data || {} }))
            .then(function (result) {
              if (result === "ok") return;
              if (attempt < 3) return wait(400 * attempt).then(tryOnce);
              throw new Error("Message could not be sent (" + result + ")");
            });
        }
        return tryOnce();
      },
      leave: function () { try { client.removeChannel(channel); } catch (e) {} }
    };

    return new Promise(function (resolve, reject) {
      var settled = false;
      channel.subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          if (options.onStatus) options.onStatus("connected");
          if (!settled) { settled = true; resolve(room); }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (options.onStatus) options.onStatus(settled ? "reconnecting" : "error");
          if (!settled) { settled = true; reject(new Error("Could not join the room (" + status + ")")); }
        } else if (status === "CLOSED") {
          if (options.onStatus) options.onStatus("reconnecting");
        }
      });
    });
  }

  // ---------- phone side: send one photo ----------
  /*
    sendPhoto(room, base64Text, info, onProgress)
      base64Text : the photo as text (no "data:image/jpeg;base64," prefix)
      info       : { type: "image/jpeg", w: 1920, h: 1080 }
      onProgress : called with a number from 0 to 1
    Resolves when the TV confirms it has the whole photo.
  */
  function sendPhoto(room, base64Text, info, onProgress) {
    var id = makeRoomCode(8);
    var pieces = splitIntoPieces(base64Text, PIECE_SIZE);
    var total = pieces.length;

    function sendPiece(i) {
      return room.send("photo-piece", { id: id, i: i, n: total, t: info.type, d: pieces[i] });
    }

    return new Promise(function (resolve, reject) {
      var finished = false;
      var timer = null;
      function armTimeout() {
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (finished) return;
          finished = true;
          reject(new Error("The TV did not confirm the photo."));
        }, CONFIRM_TIMEOUT_MS);
      }

      room.on("photo-done", function (msg) {
        if (msg.id !== id || finished) return;
        finished = true;
        clearTimeout(timer);
        if (onProgress) onProgress(1);
        resolve();
      });

      // The TV noticed gaps: resend only what it asks for.
      room.on("photo-need", function (msg) {
        if (msg.id !== id || finished) return;
        armTimeout();
        (msg.missing || []).reduce(function (chain, i) {
          return chain.then(function () { return i >= 0 && i < total ? sendPiece(i) : null; });
        }, Promise.resolve()).catch(function () {});
      });

      room.send("photo-start", { id: id, n: total, t: info.type, w: info.w, h: info.h })
        .then(function () {
          var chain = Promise.resolve();
          pieces.forEach(function (_, i) {
            chain = chain.then(function () {
              if (finished) return;
              return sendPiece(i).then(function () {
                // Keep a sliver of the bar for the TV's confirmation.
                if (onProgress) onProgress(Math.min(0.95, (i + 1) / total));
              });
            });
          });
          return chain;
        })
        .then(armTimeout)
        .catch(function (err) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ---------- TV side: receive photos ----------
  /*
    receivePhotos(room, { onStart(info), onProgress(fraction), onPhoto(dataUrl, info), onFail() })
  */
  function receivePhotos(room, callbacks) {
    var incoming = {};   // photos being assembled, by id
    var finishedIds = []; // recently completed, so late duplicates are answered politely

    function begin(id, total, type, extra) {
      if (!incoming[id]) {
        incoming[id] = { n: total, type: type || "image/jpeg", parts: new Array(total), got: 0, asks: 0, timer: null, w: extra && extra.w, h: extra && extra.h };
        if (callbacks.onStart) callbacks.onStart({ n: total });
      }
      return incoming[id];
    }

    function watchForStall(id) {
      var job = incoming[id];
      if (!job) return;
      clearTimeout(job.timer);
      job.timer = setTimeout(function () {
        if (!incoming[id]) return;
        var missing = [];
        for (var i = 0; i < job.n; i++) if (job.parts[i] === undefined) missing.push(i);
        if (job.asks >= MAX_ASKS) {
          delete incoming[id];
          if (callbacks.onFail) callbacks.onFail();
          return;
        }
        job.asks++;
        room.send("photo-need", { id: id, missing: missing }).catch(function () {});
        watchForStall(id);
      }, STALL_MS);
    }

    room.on("photo-start", function (msg) {
      if (!msg.id || !msg.n || finishedIds.indexOf(msg.id) >= 0) return;
      begin(msg.id, msg.n, msg.t, msg);
      watchForStall(msg.id);
    });

    room.on("photo-piece", function (msg) {
      if (!msg.id || typeof msg.i !== "number") return;
      if (finishedIds.indexOf(msg.id) >= 0) {           // already have it: just confirm again
        room.send("photo-done", { id: msg.id }).catch(function () {});
        return;
      }
      var job = begin(msg.id, msg.n, msg.t);
      if (msg.i < 0 || msg.i >= job.n) return;
      if (job.parts[msg.i] === undefined) { job.parts[msg.i] = msg.d; job.got++; }
      if (callbacks.onProgress) callbacks.onProgress(job.got / job.n);

      if (job.got === job.n) {
        clearTimeout(job.timer);
        delete incoming[msg.id];
        finishedIds.push(msg.id);
        if (finishedIds.length > 20) finishedIds.shift();
        var dataUrl = "data:" + job.type + ";base64," + job.parts.join("");
        room.send("photo-done", { id: msg.id }).catch(function () {});
        if (callbacks.onPhoto) callbacks.onPhoto(dataUrl, { type: job.type, w: job.w, h: job.h });
      } else {
        watchForStall(msg.id);
      }
    });
  }

  global.TVDrop = {
    makeRoomCode: makeRoomCode,
    buildPhoneLink: buildPhoneLink,
    readPhoneLink: readPhoneLink,
    join: join,
    sendPhoto: sendPhoto,
    receivePhotos: receivePhotos
  };
})(typeof window !== "undefined" ? window : globalThis);
