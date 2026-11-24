/*
  phone.js — what the phone page does.

    1. Reads the room details from the link the QR code opened.
    2. Joins the room and says "hello" until the TV answers "ready".
    3. When you pick a photo: shrinks it, then hands it to relay.js to send.

  THINGS YOU CAN SAFELY CHANGE are marked with  <-- TWEAK
*/
(function () {
  "use strict";

  var MAX_SIDE = 1920;     // <-- TWEAK  longest edge of the photo sent to the TV, in pixels (1920 = Full HD)
  var JPEG_QUALITY = 0.85; // <-- TWEAK  0.6 = smaller and faster, 0.95 = sharper and slower
  var MAX_TEXT_LENGTH = 1400000; // if the photo is still bigger than this after shrinking, quality drops a notch

  var el = function (id) { return document.getElementById(id); };
  var body = document.body;
  var room = null;
  var tvIsThere = false;
  var busy = false;

  function setStatus(kind, text) {           // kind: "wait" | "good" | "bad"
    el("dot").className = "dot " + kind;
    el("status").textContent = text;
  }
  function setState(name) {
    body.className = body.className.replace(/state-\S+/g, "").trim() + " state-" + name;
  }
  function refreshButton() {
    el("pick").disabled = !room || busy;
  }

  // ---------- 1. read the link ----------
  var link = TVDrop.readPhoneLink(location.hash);
  if (!link) {
    setState("nolink");
    setStatus("bad", "No TV linked");
    el("title").textContent = "Scan the code on your TV";
    el("hint").textContent = "This page only works when it's opened from the QR code shown on the TV.";
    return;
  }

  // ---------- 2. join the room ----------
  TVDrop.join({
    supabaseUrl: link.supabaseUrl,
    supabaseKey: link.supabaseKey,
    room: link.room,
    onStatus: function (state) {
      if (state === "connected") setStatus(tvIsThere ? "good" : "wait", tvIsThere ? "Connected to the TV" : "Looking for the TV…");
      else if (state === "reconnecting") setStatus("wait", "Reconnecting…");
      else setStatus("bad", "Can't connect");
    }
  }).then(function (joined) {
    room = joined;
    setState("ready");
    refreshButton();

    room.on("ready", function () {
      tvIsThere = true;
      if (!busy) setStatus("good", "Connected to the TV");
    });

    // Keep saying hello until the TV answers (it may still be starting up).
    (function hello() {
      if (tvIsThere) return;
      room.send("hello", {}).catch(function () {});
      setTimeout(hello, 2000);
    })();
  }).catch(function () {
    setState("nolink");
    setStatus("bad", "Can't connect");
    el("title").textContent = "Couldn't reach the room";
    el("hint").textContent = "Check your internet connection, then scan the code on the TV again.";
  });

  // ---------- 3. pick, shrink, send ----------
  el("pick").addEventListener("click", function () { el("file").click(); });

  el("file").addEventListener("change", function () {
    var file = el("file").files && el("file").files[0];
    el("file").value = "";            // lets you pick the same photo twice in a row
    if (!file || busy || !room) return;

    busy = true;
    refreshButton();
    setState("sending");
    setStatus("wait", "Getting the photo ready…");
    el("fill").style.width = "0%";
    el("badge").textContent = "Sending…";

    shrink(file).then(function (photo) {
      el("thumb").src = "data:image/jpeg;base64," + photo.base64;
      body.classList.add("has-photo");
      setStatus("wait", "Sending to the TV…");
      return TVDrop.sendPhoto(room, photo.base64, { type: "image/jpeg", w: photo.w, h: photo.h }, function (fraction) {
        el("fill").style.width = Math.round(fraction * 100) + "%";
      });
    }).then(function () {
      tvIsThere = true;
      setStatus("good", "On the TV");
      el("badge").textContent = "On the TV";
      el("title").textContent = "Sent!";
      el("hint").textContent = "Look up — it's on the big screen.";
      el("pick").textContent = "Send another";
    }).catch(function (err) {
      console.error("[tvdrop]", err);
      setStatus("bad", "Didn't arrive");
      el("badge").textContent = "Not sent";
      el("title").textContent = "That one didn't make it";
      el("hint").textContent = "Make sure the TV still shows the code screen or a photo, then try again.";
      el("pick").textContent = "Try again";
    }).then(function () {
      busy = false;
      setState("ready");
      refreshButton();
    });
  });

  // Turns any photo into a JPEG no larger than MAX_SIDE, as base64 text.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * scale));
          var h = Math.max(1, Math.round(img.naturalHeight * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#000";            // transparent PNGs get a black backdrop
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          var quality = JPEG_QUALITY, base64;
          do {
            base64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
            quality -= 0.1;
          } while (base64.length > MAX_TEXT_LENGTH && quality > 0.4);

          URL.revokeObjectURL(url);
          resolve({ base64: base64, w: w, h: h });
        } catch (err) { reject(err); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file isn't a photo this phone can open.")); };
      img.src = url;
    });
  }
})();
