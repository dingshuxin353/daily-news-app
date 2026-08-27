const body = document.body;
const basePath = body.dataset.basePath || "";
const genericError = "请求未完成。请检查输入后重试。";

function setFormState(form, state, message) {
  form.dataset.state = state;
  const helper = form.querySelector("[data-helper]");
  if (helper) helper.textContent = message;
  for (const input of form.querySelectorAll("input")) {
    input.setAttribute("aria-invalid", state === "error" ? "true" : "false");
  }
}

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

const emailForm = document.querySelector("[data-email-form]");
const otpForm = document.querySelector("[data-otp-form]");

if (emailForm instanceof HTMLFormElement && otpForm instanceof HTMLFormElement) {
  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const emailInput = emailForm.elements.namedItem("email");
    if (!(emailInput instanceof HTMLInputElement) || !emailInput.validity.valid) {
      setFormState(emailForm, "error", "邮箱格式不正确，请检查后重试。");
      emailInput?.focus();
      return;
    }
    setBusy(emailForm, true, "发送中…");
    setFormState(emailForm, "loading", "正在请求验证码。");
    try {
      const response = await postJson("/api/auth/email-otp/send-verification-otp", {
        email: emailInput.value,
        type: "sign-in",
      });
      if (!response.ok) {
        const message = response.status === 429 ? "请求过于频繁，请稍后再试。" : genericError;
        setFormState(emailForm, "error", message);
        return;
      }
      const otpEmail = otpForm.elements.namedItem("email");
      if (otpEmail instanceof HTMLInputElement) otpEmail.value = emailInput.value;
      otpForm.hidden = false;
      setFormState(emailForm, "success", "验证码已发送。请查看邮箱并在 5 分钟内输入。");
      const otpInput = otpForm.elements.namedItem("otp");
      if (otpInput instanceof HTMLInputElement) otpInput.focus();
    } catch {
      setFormState(emailForm, "error", genericError);
    } finally {
      setBusy(emailForm, false, "发送中…");
    }
  });

  otpForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = otpForm.elements.namedItem("email");
    const otp = otpForm.elements.namedItem("otp");
    if (!(email instanceof HTMLInputElement) || !(otp instanceof HTMLInputElement) || !otp.validity.valid) {
      setFormState(otpForm, "error", "验证码应为 6 位数字，请检查后重试。");
      otp?.focus();
      return;
    }
    setBusy(otpForm, true, "验证中…");
    setFormState(otpForm, "loading", "正在验证验证码。");
    try {
      const response = await postJson("/api/auth/sign-in/email-otp", { email: email.value, otp: otp.value });
      if (!response.ok) {
        setFormState(otpForm, "error", "验证码无效或已过期，请重新获取后再试。");
        return;
      }
      setFormState(otpForm, "success", "验证成功，正在进入私有空间。");
      window.location.assign(`${basePath}/`);
    } catch {
      setFormState(otpForm, "error", genericError);
    } finally {
      setBusy(otpForm, false, "验证中…");
    }
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
