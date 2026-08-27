const body = document.body;
const basePath = body.dataset.basePath || "";

const pageSelect = document.querySelector("[data-page-select]");
if (pageSelect instanceof HTMLSelectElement) {
  pageSelect.addEventListener("change", () => window.location.assign(pageSelect.value));
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const key = button.dataset.copy;
    const source = document.querySelector(`[data-copy-source="${CSS.escape(key)}"]`);
    const status = document.querySelector(`[data-copy-status="${CSS.escape(key)}"]`);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent || "");
      if (status) status.textContent = key === "pairing" ? "配对码已复制。" : "设置话术已复制。";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (status) status.textContent = "浏览器未允许自动复制，内容已选中，请手工复制。";
    }
  });
}

const oneTimeSecret = document.querySelector('[data-copy-source="secret"]');
if (oneTimeSecret instanceof HTMLElement) {
  window.history.replaceState(null, "", `${basePath}/settings/agent/manual-tokens`);
  window.addEventListener("pagehide", () => {
    oneTimeSecret.textContent = "";
  }, { once: true });
}

const expiry = document.querySelector("[data-pairing-expiry]");
if (expiry instanceof HTMLTimeElement) {
  const label = document.querySelector("[data-pairing-label]");
  let refreshedAfterExpiry = false;
  const update = () => {
    const seconds = Math.max(0, Math.ceil((new Date(expiry.dateTime).getTime() - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    expiry.textContent = seconds > 0 ? `剩余 ${minutes}:${remainder}` : "已到期，正在获取当前码";
    if (seconds === 0 && label) label.textContent = "正在生成当前配对码";
    if (seconds === 0 && !refreshedAfterExpiry) {
      refreshedAfterExpiry = true;
      window.location.reload();
    }
  };
  update();
  window.setInterval(update, 1000);
}

const pairingRoot = document.querySelector("[data-pairing-id]");
if (pairingRoot instanceof HTMLElement && pairingRoot.dataset.pairingStatus !== "verified") {
  const pairingId = pairingRoot.dataset.pairingId;
  window.setInterval(async () => {
    try {
      const response = await fetch(`${basePath}/settings/agent/connections/${encodeURIComponent(pairingId)}/pair`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.pairing?.status !== pairingRoot.dataset.pairingStatus) window.location.reload();
    } catch {
      // Polling is progressive enhancement; manual refresh remains available.
    }
  }, 5000);
}

if (window.location.hash && body.dataset.page === "todo") {
  const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
  const status = document.querySelector("[data-anchor-status]");
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  } else if (status instanceof HTMLElement) {
    status.hidden = false;
    status.focus();
  }
}
