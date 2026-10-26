# SlideLink laptop helper

The helper is a small Python script that receives commands from the web app and presses the left/right arrow keys on the active laptop window. This lets it control a Google Slides presentation in the browser or Microsoft PowerPoint desktop, as long as the slideshow window is focused.

## Windows setup

1. Install Python 3.10 or newer from https://www.python.org/downloads/ and enable **Add Python to PATH**.
2. Open PowerShell in this `helper` folder.
3. Run:

   ```powershell
   py -m pip install -r requirements.txt
   py slidelink_helper.py
   ```

4. Enter the six-digit code shown on the SlideLink laptop page.

## macOS / Linux setup

```bash
python3 -m pip install -r requirements.txt
python3 slidelink_helper.py
```

If the server is not running on the same laptop, set `SLIDELINK_SERVER` to its HTTP base URL, for example `http://192.168.1.20:3000`.

## Important

- Start the slideshow first, then click the slideshow window so it has keyboard focus.
- On macOS, you may need to grant Accessibility permission to the terminal/Python app.
- On Linux, desktop automation permissions depend on your display server/session.
- The helper sends keyboard events to the active window. It cannot guarantee control of a window that is not focused.
- Keep the helper on a trusted local network. The six-digit code is a convenience pairing mechanism, not enterprise-grade authentication.
