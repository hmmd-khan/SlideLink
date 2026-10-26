# Test report

## Automated checks
Run `npm test`. The test suite covers:
- health endpoint
- session creation and six-digit code format
- invalid session WebSocket rejection
- remote-to-helper command relay

## Manual checks still required on your hardware
The runtime used to create this archive does not have access to your phone or desktop UI. Before a real presentation, test:
1. Open SlideLink on the laptop and create a session.
2. Start the Python helper and enter the code.
3. Open the phone remote using the laptop's LAN IP.
4. Tap Next and Previous; verify the helper logs the commands.
5. Open Google Slides or PowerPoint slideshow, focus it, and test actual slide movement.
6. Test firewall and Wi-Fi isolation behavior on your own network.
7. For macOS, test Accessibility permission.

Do not treat hardware-level validation as completed until those manual steps pass.
