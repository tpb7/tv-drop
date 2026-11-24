# tv-drop

Send a photo from a phone to a TV screen by scanning a QR code. A first test of phone-to-TV pairing.

- The page at the top level is what the phone opens after scanning the code.
- `tv/` is the TV screen (also packaged as an LG webOS app).
- `relay.js` is the shared messaging code; the same file sits in both places.

Photos travel through a live message channel (Supabase Realtime) in small pieces. Nothing is stored online, and no keys are kept in this repository: the TV passes them to the phone inside the QR code.
