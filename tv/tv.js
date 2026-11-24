/*
  tv.js — what the TV app does.

    1. Reads your two Supabase values from config.js.
    2. Invents a fresh room code and draws the QR code that leads a phone into that room.
    3. Waits. When photo pieces arrive, relay.js glues them together and this file shows the result.

  Remote control:
    BACK  — from a photo, return to the code screen
    OK    — hide / show the small "Send another" corner card

  THINGS YOU CAN SAFELY CHANGE are marked with  <-- TWEAK
*/
(function () {
  "use strict";

  var RETRY_SECONDS = 6;   // <-- TWEAK  how often the TV retries if it can't reach the room

  var el = function (id) { return document.getElementById(id); };
  var config = window.TVDROP_CONFIG || {};
  var roomCode = TVDrop.makeRoomCode(10);   // new code every time the app starts

  function show(screenId) {
    ["codeScreen", "photoScreen", "noteScreen"].forEach(function (id) {
      el(id).classList.toggle("on", id === screenId);
    });
  }
  function setStatus(kind, text) {            // kind: "wait" | "good" | "bad"
    el("dot").className = "dot " + kind;
    el("status").textContent = text;
  }
  function note(kicker, title, line1, line2) {
    el("noteKicker").textContent = kicker;
    el("noteTitle").textContent = title;
    el("noteLine1").innerHTML = line1 || "";
    el("noteLine2").innerHTML = line2 || "";
    show("noteScreen");
  }

  // Draws a QR code onto a <canvas>. "quiet" is the white margin, counted in QR squares.
  function drawQr(canvas, text, quiet) {
    var qr = qrcode(0, "M");       // 0 = pick the smallest size that fits; M = medium error correction
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var scale = 8;                  // pixels per QR square (CSS then stretches it, kept sharp by image-rendering)
    var size = (count + quiet * 2) * scale;
    canvas.width = size; canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#0e1020";
    for (var r = 0; r < count; r++)
      for (var c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }

  // ---------- 1. check config ----------
  function unset(value) { return !value || /PASTE_/.test(value); }

  // The two values can also arrive in the page address, after the # (…/tv/#u=…&k=…).
  // That lets a copy of this screen hosted online run without any key saved in its files.
  if (unset(config.supabaseUrl) || unset(config.supabaseKey)) {
    var fromAddress = TVDrop.readPhoneLink(location.hash + "&r=-");
    if (fromAddress) {
      config.supabaseUrl = fromAddress.supabaseUrl;
      config.supabaseKey = fromAddress.supabaseKey;
    }
  }

  if (unset(config.supabaseUrl) || unset(config.supabaseKey)) {
    note("Setup", "Two values to paste",
      "Open <code>config.js</code> in this app's folder and paste your Supabase <code>Project URL</code> and <code>Publishable key</code>.",
      "Save the file, then install the app again.");
    return;
  }

  // ---------- 2. room + QR code ----------
  var phoneLink = TVDrop.buildPhoneLink(config.phonePageUrl, config.supabaseUrl.trim(), config.supabaseKey.trim(), roomCode);
  document.body.setAttribute("data-phone-link", phoneLink);   // handy when testing in a laptop browser
  drawQr(el("qrBig"), phoneLink, 1);
  drawQr(el("qrSmall"), phoneLink, 1);
  show("codeScreen");

  // ---------- 3. join and listen ----------
  function start() {
    setStatus("wait", "Opening the room…");
    TVDrop.join({
      supabaseUrl: config.supabaseUrl.trim(),
      supabaseKey: config.supabaseKey.trim(),
      room: roomCode,
      onStatus: function (state) {
        if (state === "connected") setStatus("wait", "Waiting for a phone");
        else if (state === "reconnecting") setStatus("wait", "Reconnecting…");
      }
    }).then(function (room) {
      // A phone says hello -> answer so it knows the TV is listening.
      room.on("hello", function () {
        setStatus("good", "Phone connected");
        room.send("ready", {}).catch(function () {});
      });
      room.send("ready", {}).catch(function () {});

      TVDrop.receivePhotos(room, {
        onStart: function () {
          setStatus("good", "Photo on its way…");
          el("progress").style.width = "4%";
          el("progress").classList.add("on");
        },
        onProgress: function (fraction) {
          el("progress").style.width = Math.max(4, Math.round(fraction * 100)) + "%";
        },
        onPhoto: function (dataUrl) {
          var img = el("photo");
          img.onload = function () {
            show("photoScreen");
            el("chip").classList.remove("hidden");
            el("progress").classList.remove("on");
            setTimeout(function () { el("progress").style.width = "0%"; }, 500);
            setStatus("good", "Phone connected");
          };
          img.src = dataUrl;
        },
        onFail: function () {
          el("progress").classList.remove("on");
          el("progress").style.width = "0%";
          setStatus("bad", "A photo got lost on the way — try again");
        }
      });
    }).catch(function (err) {
      console.error("[tvdrop]", err);
      setStatus("bad", "Can't reach the room — retrying");
      setTimeout(start, RETRY_SECONDS * 1000);
    });
  }
  start();

  // ---------- remote control ----------
  document.addEventListener("keydown", function (event) {
    var onPhoto = el("photoScreen").classList.contains("on");
    var isBack = event.keyCode === 461 || event.keyCode === 27 || event.keyCode === 8;   // 461 = LG remote BACK
    var isOk = event.keyCode === 13;
    if (isBack && onPhoto) { show("codeScreen"); event.preventDefault(); }
    else if (isOk && onPhoto) { el("chip").classList.toggle("hidden"); }
  });

  // No remote? (laptop or tablet) Tap or click the photo to go back to the code screen.
  el("photoScreen").addEventListener("click", function () { show("codeScreen"); });
})();
