#!/usr/bin/env python3
"""SlideLink laptop helper: polls the local server and sends arrow keys."""
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


def request_json(path, method="GET", payload=None, timeout=5):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(SERVER + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    code = input("Enter the 6-digit SlideLink code shown in the laptop browser: ").strip()
    if not (code.isdigit() and len(code) == 6):
        print("The code must contain exactly 6 digits.")
        return 2
    try:
        request_json("/api/agent/connect", "POST", {"code": code})
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        print(f"Could not connect to SlideLink server at {SERVER}: {exc}")
        print("Start the Node server first. Set SLIDELINK_SERVER if it is not on this laptop.")
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
                        pyautogui.press(key)
                        print(f"Sent {command} ({key} arrow)")
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    print("Session expired or invalid. Create a new session.")
                    return 1
                print(f"Server error: {exc}")
                time.sleep(1)
            except (urllib.error.URLError, TimeoutError) as exc:
                print(f"Connection interrupted: {exc}. Retrying…")
                time.sleep(1)
            time.sleep(0.12)
    except KeyboardInterrupt:
        print("\nSlideLink helper stopped.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nSlideLink helper stopped.")
