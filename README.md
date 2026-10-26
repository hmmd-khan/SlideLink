# SlideLink — web presentation remote

SlideLink is a low-cost, web-first MVP for controlling a laptop presentation from a phone. It works with Google Slides and Microsoft PowerPoint by sending left/right keyboard input to the currently active laptop window.

**It does not require a native iOS or Android app.** It does require a small laptop helper script because a phone webpage cannot directly send keyboard input to another device.

## Features

- Mobile-friendly web remote with Next and Previous controls.
- Six-digit pairing sessions.
- Local Wi-Fi communication using lightweight HTTP polling; no cloud account or database.
- Laptop helper supports Google Slides in a browser and desktop PowerPoint.
- Session cleanup after three hours.
- Simple connection status and command feedback.

## Requirements

- Node.js 18 or newer
- Python 3.10 or newer on the laptop
- Laptop and phone connected to the same Wi-Fi network
- Internet is not required after dependencies are installed

## Start the server

From the project root:

```bash
npm install
npm start
```

Open `http://localhost:3000` on the laptop. Click **Create pairing code**.

## Connect the laptop helper

In a second terminal, open the `helper` directory and install its dependencies.

Windows:

```powershell
cd helper
py -m pip install -r requirements.txt
py slidelink_helper.py
```

macOS / Linux:

```bash
cd helper
python3 -m pip install -r requirements.txt
python3 slidelink_helper.py
```

Enter the pairing code from the laptop webpage.

## Connect the phone

1. Ensure the phone and laptop are on the same Wi-Fi network.
2. On the laptop home page, find a LAN address in the "Open the remote on your phone" section.
3. On the phone, open `http://LAPTOP-IP:3000/remote.html`.
4. Enter the same six-digit code and tap **Connect**.
5. Start or return to the presentation and click the slideshow window to focus it.
6. Use Next / Previous on the phone.

If the phone cannot open the address, allow Node.js through the laptop firewall for private networks. Some guest Wi-Fi networks block communication between devices.

## Optional: iPhone Back Tap via Shortcuts

The web remote's on-screen buttons work on both iOS and Android. As an optional iPhone experiment, you can make two Shortcuts that send a command to the laptop server, then assign them to Back Tap:

1. Create a shortcut named **Next Slide**.
2. Add **Get Contents of URL** with URL `http://LAPTOP-IP:3000/api/commands` (replace `LAPTOP-IP` with the laptop's Wi-Fi IP address).
3. Set Method to **POST**, request body to **JSON**, and add `code` as the session's six-digit code and `command` as `NEXT`.
4. Create another shortcut named **Previous Slide** with the same URL and `command` set to `PREVIOUS`.
5. On iPhone, open **Settings → Accessibility → Touch → Back Tap**. Assign Double Tap to Next Slide and Triple Tap to Previous Slide, if those options are available on your iOS version.

This is an optional manual setup, not a built-in feature of the website. It requires the phone to reach the laptop over the same Wi-Fi, the session to be active, and the laptop helper to be running. iOS may show network permission prompts, and Shortcut execution should be tested on your device. This does not make physical Volume Up/Down buttons programmable.

## Test

Run the automated test suite:

```bash
npm test
```

The automated tests verify health checks, session creation, invalid-session rejection, offline command rejection, and command queue delivery. They do not replace testing on a real phone or desktop presentation app.

## Limitations and safety

- The phone and laptop must be on the same local network in this MVP.
- The laptop helper sends `RIGHT` and `LEFT` arrow key presses to the currently focused application. Keep the slideshow window focused; otherwise, another app could receive the key.
- Hardware volume-button and Back Tap support are not included. Browsers do not expose those events consistently.
- This MVP uses a six-digit pairing code without user accounts. Do not expose it to an untrusted network.
- The app does not upload, store, or read presentation files.
- For a public internet version, use authenticated sessions, WSS/TLS, and a hosted relay service rather than exposing this local server.

## Troubleshooting

- **Helper says connection refused:** start `npm start` first.
- **Phone cannot connect:** use the laptop's LAN IP, not `localhost`; confirm same Wi-Fi and firewall rules.
- **Buttons say helper is disconnected:** run the helper and enter the current session code.
- **Slides don't move:** click the presentation/slideshow window to focus it, then try again.
- **macOS doesn't send keys:** grant Accessibility permission to Terminal/Python.
