const joinPanel = document.querySelector("#joinPanel");
const controlPanel = document.querySelector("#controlPanel");
const codeInput = document.querySelector("#codeInput");
const joinButton = document.querySelector("#join");
const joinError = document.querySelector("#joinError");
const previousButton = document.querySelector("#previous");
const nextButton = document.querySelector("#next");
const disconnectButton = document.querySelector("#disconnect");
const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const feedback = document.querySelector("#feedback");
let sessionCode = null;
let agentConnected = false;
let statusTimer = null;
let lastTap = 0;
const remoteId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 80);
let heartbeatTimer = null;

const params = new URLSearchParams(location.search);
if (/^\d{6}$/.test(params.get("code") || "")) codeInput.value = params.get("code");

function setConnection(connected) {
  connectionDot.className = connected && agentConnected ? "dot good" : "dot";
  connectionText.textContent = !connected ? "Disconnected" : (agentConnected ? "Connected to laptop" : "Connected · waiting for laptop helper");
  previousButton.disabled = !connected || !agentConnected;
  nextButton.disabled = !connected || !agentConnected;
}

async function sendHeartbeat() {
  if (!sessionCode) return;
  try {
    await fetch("/api/remote/heartbeat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: sessionCode, remoteId })
    });
  } catch { /* next heartbeat retries */ }
}

async function pollStatus() {
  if (!sessionCode) return;
  sendHeartbeat();
  try {
    const response = await fetch(`/api/sessions/${sessionCode}/status`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Session expired");
    agentConnected = Boolean(data.agentConnected);
    setConnection(true);
    if (!agentConnected) feedback.textContent = "Waiting for the laptop helper…";
  } catch (error) {
    agentConnected = false;
    setConnection(false);
    feedback.textContent = error.message || "Connection lost.";
  }
}

async function sendCommand(command) {
  if (!sessionCode || !agentConnected) {
    feedback.textContent = "Laptop helper is not connected yet.";
    return;
  }
  const now = Date.now();
  if (now - lastTap < 180) return;
  lastTap = now;
  try {
    const response = await fetch("/api/commands", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: sessionCode, command })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Command failed");
    feedback.textContent = command === "NEXT" ? "Next slide command sent ✓" : "Previous slide command sent ✓";
    if (navigator.vibrate) navigator.vibrate(20);
  } catch (error) {
    feedback.textContent = error.message || "Could not send command.";
  }
}

async function connect() {
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    joinError.textContent = "Enter the 6-digit code shown on the laptop.";
    return;
  }
  joinButton.disabled = true;
  joinError.textContent = "";
  try {
    const response = await fetch(`/api/sessions/${code}/status`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Invalid code");
    sessionCode = code;
    agentConnected = Boolean(data.agentConnected);
    joinPanel.classList.add("hidden");
    controlPanel.classList.remove("hidden");
    setConnection(true);
    feedback.textContent = agentConnected ? "Ready. Tap Next or Previous." : "Connected. Waiting for the laptop helper…";
    if (statusTimer) clearInterval(statusTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, 3000);
    statusTimer = setInterval(pollStatus, 1500);
  } catch (error) {
    joinError.textContent = error.message || "Could not connect. Check the code and Wi-Fi.";
  } finally {
    joinButton.disabled = false;
  }
}

function disconnect() {
  if (statusTimer) clearInterval(statusTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  statusTimer = null;
  heartbeatTimer = null;
  sessionCode = null;
  agentConnected = false;
  controlPanel.classList.add("hidden");
  joinPanel.classList.remove("hidden");
  setConnection(false);
}
joinButton.addEventListener("click", connect);
codeInput.addEventListener("keydown", event => { if (event.key === "Enter") connect(); });
codeInput.addEventListener("input", () => { codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6); });
previousButton.addEventListener("click", () => sendCommand("PREVIOUS"));
nextButton.addEventListener("click", () => sendCommand("NEXT"));
disconnectButton.addEventListener("click", disconnect);
