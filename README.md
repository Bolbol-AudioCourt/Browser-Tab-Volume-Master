# Volume Master

A browser extension that lets you control the current tab’s volume and EQ.

## Install in Firefox
1. Run:
   ```bash
   python3 scripts/build_targets.py
   ```
2. Open Firefox and go to:
   `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...**
4. Select:
   `dist/firefox/manifest.json`

## Install in Chrome
1. Run:
   ```bash
   python3 scripts/build_targets.py
   ```
2. Open Chrome and go to:
   `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select the folder:
   `dist/chrome`
