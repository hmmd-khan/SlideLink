#!/usr/bin/env python3
"""SlideLink laptop helper: polls the SlideLink server and sends arrow keys.

Optional: pass the six-digit code as an argument (python slidelink_helper.py 123456).
Environment variables:
  SLIDELINK_SERVER         backend base URL (default http://127.0.0.1:3000)
  SLIDELINK_POLL_INTERVAL  seconds between polls (default 0.3)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

try:
    import pyautogui
except ImportError:
    print("Missing dependency. Run: python -m pip install -r requirements.txt")
    raise SystemExit(1)

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.03
SERVER = os.environ.get("SLIDELINK_SERVER", "http://127.0.0.1:3000").rstrip("/")
VALID_COMMANDS = {"NEXT": "right", "PREVIOUS": "left"}
# Each poll to a cloud server costs a few database commands, so don't poll faster than needed.
POLL_INTERVAL = max(0.1, float(os.environ.get("SLIDELINK_POLL_INTERVAL", "0.3")))


def request_json(path, method="GET", payload=None, timeout=5):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"User-Agent": "SlideLinkHelper/1.1"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(SERVER + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    if not SERVER.startswith(("http://", "https://")):
        print("SLIDELINK_SERVER must start with http:// or https://")
        return 2
    if len(sys.argv) > 1:
        code = sys.argv[1].strip()
    else:
        code = input("Enter the 6-digit SlideLink code shown in the laptop browser: ").strip()
    if not (code.isdigit() and len(code) == 6):
        print("The code must contain exactly 6 digits.")
        return 2
    print(f"Server: {SERVER}")
    try:
        request_json("/api/agent/connect", "POST", {"code": code})
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            print("That code was not found or has expired. Create a new session on the website.")
        else:
            print(f"The server rejected the connection: {exc}")
        return 1
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"Could not connect to SlideLink server at {SERVER}: {exc}")
        print("Check your internet connection, or start the local Node server first.")
        print("Set SLIDELINK_SERVER if the server is not on this laptop.")
        return 1

    print("\nConnected to SlideLink.")
    print("Keep the slideshow window active. Commands go to whichever app is focused.")
    print("Press Ctrl+C here to stop the helper.\n")
    try:
        while True:
            try:
                data = request_json(f"/api/agent/poll?code={code}", timeout=5)
                command_data = data.get("command")
                if command_data:
                    command = command_data.get("command")
                    key = VALID_COMMANDS.get(command)
                    if key:
                        try:
                            pyautogui.press(key)
                            print(f"Sent {command} ({key} arrow)")
                        except Exception as exc:  # e.g. pyautogui fail-safe (mouse in a screen corner)
                            print(f"Could not press {key}: {exc}")
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    print("Session expired or invalid. Create a new session.")
                    return 1
                print(f"Server error: {exc}")
                time.sleep(2 if exc.code == 429 else 1)
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                print(f"Connection interrupted: {exc}. Retrying…")
                time.sleep(1)
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        print("\nSlideLink helper stopped.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nSlideLink helper stopped.")
