const createButton = document.querySelector("#create");
const newSessionButton = document.querySelector("#newSession");
const sessionPanel = document.querySelector("#session");
const codeLabel = document.querySelector("#code");
const statusLabel = document.querySelector("#status");
const remoteStatus = document.querySelector("#remoteStatus");
const addressList = document.querySelector("#addressList");
let currentCode = null;
let pollTimer = null;

async function loadAddresses() {
  try {
    const response = await fetch("/api/addresses");
    const data = await response.json();
    addressList.replaceChildren();
    if (!data.addresses.length) {
      addressList.innerHTML = "<li>No LAN address detected. Check your Wi-Fi connection.</li>";
      return;
    }
    for (const ip of data.addresses) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `http://${ip}:${location.port || "3000"}/remote.html`;
      a.textContent = a.href;
      li.appendChild(a);
      addressList.appendChild(li);
    }
  } catch {
    addressList.innerHTML = "<li>Could not detect local addresses.</li>";
  }
}

async function createSession() {
  createButton.disabled = true;
  newSessionButton.disabled = true;
  try {
    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) throw new Error("Could not create session.");
    const data = await response.json();
    currentCode = data.code;
    codeLabel.textContent = data.code;
    sessionPanel.classList.remove("hidden");
    createButton.classList.add("hidden");
    statusLabel.innerHTML = '<span class="dot"></span> Waiting for laptop helper…';
    remoteStatus.textContent = "";
    if (pollTimer) clearInterval(pollTimer);
    pollStatus();
    pollTimer = setInterval(pollStatus, 1800);
    await loadAddresses();
  } catch (error) {
    alert(error.message || "Could not create session.");
  } finally {
    createButton.disabled = false;
    newSessionButton.disabled = false;
  }
}

async function pollStatus() {
  if (!currentCode) return;
  try {
    const response = await fetch(`/api/sessions/${currentCode}/status`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    const dotClass = data.agentConnected ? "dot good" : "dot";
    statusLabel.innerHTML = `<span class="${dotClass}"></span> ${data.agentConnected ? "Laptop helper connected" : "Waiting for laptop helper…"}`;
    remoteStatus.textContent = `${data.remoteCount} phone remote${data.remoteCount === 1 ? "" : "s"} connected · ${data.commands} commands sent`;
  } catch {
    statusLabel.innerHTML = '<span class="dot bad"></span> Session expired or server unavailable';
  }
}
createButton.addEventListener("click", createSession);
newSessionButton.addEventListener("click", createSession);
loadAddresses();
