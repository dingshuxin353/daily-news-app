const body = document.body;
const basePath = body.dataset.basePath || "";

function setBusy(form, busy, busyLabel) {
  const button = form.querySelector("button[type='submit']");
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? busyLabel : button.dataset.label;
}

async function postJson(pathname, bodyValue) {
  return fetch(`${basePath}${pathname}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyValue),
  });
}

const logoutForm = document.querySelector("[data-logout-form]");
if (logoutForm instanceof HTMLFormElement) {
  logoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(logoutForm, true, "退出中…");
    try {
      const response = await postJson("/api/auth/sign-out", {});
      if (!response.ok) return;
      window.location.assign(`${basePath}/login`);
    } finally {
      setBusy(logoutForm, false, "退出中…");
    }
  });
}
