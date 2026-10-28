# Test-only stand-in for pyautogui: appends each pressed key to $STUB_PRESS_LOG.
import os

def press(key):
    with open(os.environ["STUB_PRESS_LOG"], "a") as f:
        f.write(key + "\n")
