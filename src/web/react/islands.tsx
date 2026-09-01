import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { IconArrowLeft, IconArrowNarrowRight, IconCheck, IconCopy } from "@tabler/icons-react";
import { FieldShell } from "./ui.js";

type FormState = "idle" | "loading" | "error" | "success";

function safeMessage(response: Response, fallback: string): string {
  if (response.status === 429) return "请求过于频繁。请稍后再试。";
  return fallback;
}

async function postJson(basePath: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${basePath}${pathname}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function LoginIsland({ basePath, returnTo }: { basePath: string; returnTo?: string }) {
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [message, setMessage] = useState("验证码有效期为 5 分钟。");
  const otpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "otp") otpRef.current?.focus();
  }, [step]);

  async function sendOtp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      setState("error");
      setMessage("邮箱格式不正确。请检查后重新输入。");
      form.reportValidity();
      return;
    }
    setState("loading");
    setMessage("正在发送验证码…");
    try {
      const response = await postJson(basePath, "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
      if (!response.ok) {
        setState("error");
        setMessage(safeMessage(response, "验证码没有发送成功。请检查邮箱后重试。"));
        return;
      }
      setState("success");
      setMessage("验证码已发送。请查看邮箱并在 5 分钟内输入。");
      setStep("otp");
    } catch {
      setState("error");
      setMessage("网络请求没有完成。请检查连接后重试。");
    }
  }

  async function verifyOtp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity() || !/^\d{6}$/.test(otp)) {
      setState("error");
      setMessage("验证码应为 6 位数字。请检查后重新输入。");
      form.reportValidity();
      return;
    }
    setState("loading");
    setMessage("正在验证验证码…");
    try {
      const response = await postJson(basePath, "/api/auth/sign-in/email-otp", { email, otp });
      if (!response.ok) {
        setState("error");
        setMessage("验证码无效或已过期。请重新获取后再试。");
        return;
      }
      setState("success");
      setMessage("验证成功，正在进入你的私人编辑部。");
      const destination = new URL(`${basePath}/post-login`, window.location.origin);
      const todoAnchor = /^#todo-[a-f0-9]{8}$/.test(window.location.hash) && returnTo?.endsWith("/todo/")
        ? window.location.hash
        : "";
      if (returnTo) destination.searchParams.set("returnTo", `${returnTo}${todoAnchor}`);
      window.location.assign(`${destination.pathname}${destination.search}`);
    } catch {
      setState("error");
      setMessage("网络请求没有完成。请检查连接后重试。");
    }
  }

  const error = state === "error" ? message : undefined;
  return <Theme theme={neutralTheme} mode="light">
    <div className="m51-login-form-island" data-state={state}>
      <p className="m51-kicker">Sign in or create account</p>
      <h2>{step === "email" ? "邮箱登录" : "输入验证码"}</h2>
      <p className="m51-form-lede">{step === "email"
        ? "如果这个邮箱还没有账户，验证后会自动建立自己的私有空间。"
        : `验证码已发送到 ${email}`}</p>
      {step === "email" ? <form onSubmit={sendOtp} noValidate>
        <FieldShell id="email" label="邮箱地址" helper={message} error={error}>
          <input
            id="email"
            className="m51-input"
            name="email"
            type="email"
            value={email}
            onChange={(event) => { setEmail(event.target.value); if (state === "error") setState("idle"); }}
            autoComplete="email"
            inputMode="email"
            aria-describedby="email-message"
            aria-invalid={Boolean(error)}
            aria-required="true"
            disabled={state === "loading"}
            required
          />
        </FieldShell>
        <Button
          className="m51-button m51-button--wide"
          label="发送验证码"
          variant="primary"
          size="lg"
          type="submit"
          isLoading={state === "loading"}
          endContent={<IconArrowNarrowRight size={18} stroke={1.8} aria-hidden="true" />}
        />
      </form> : <form onSubmit={verifyOtp} noValidate>
        <FieldShell id="otp" label="6 位验证码" helper={message} error={error}>
          <input
            ref={otpRef}
            id="otp"
            className="m51-input"
            name="otp"
            type="text"
            value={otp}
            onChange={(event) => { setOtp(event.target.value.replace(/\D/g, "").slice(0, 6)); if (state === "error") setState("idle"); }}
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            aria-describedby="otp-message"
            aria-invalid={Boolean(error)}
            aria-required="true"
            disabled={state === "loading"}
            required
          />
        </FieldShell>
        <button className="m51-text-action" type="button" onClick={() => { setStep("email"); setOtp(""); setState("idle"); setMessage("验证码有效期为 5 分钟。"); }}>
          <IconArrowLeft size={16} stroke={1.8} aria-hidden="true" />更换邮箱
        </button>
        <Button
          className="m51-button m51-button--wide"
          label="进入编辑部"
          variant="primary"
          size="lg"
          type="submit"
          isLoading={state === "loading"}
          endContent={<IconArrowNarrowRight size={18} stroke={1.8} aria-hidden="true" />}
        />
      </form>}
      <p className="m51-privacy-note">验证码只用于本次登录；DailyNews 不提供密码登录，也不会在浏览器持久保存邮箱。</p>
    </div>
  </Theme>;
}

type CopyState = "idle" | "copied" | "manual";

async function copyText(value: string, source: HTMLElement | null): Promise<CopyState> {
  try {
    await navigator.clipboard.writeText(value);
    return "copied";
  } catch {
    if (source) {
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(source);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return "manual";
  }
}

export function CopyInstructionIsland({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const sourceRef = useRef<HTMLPreElement>(null);
  return <Theme theme={neutralTheme} mode="light">
    <div className="m51-copy-block">
      <pre ref={sourceRef}>{text}</pre>
      <Button
        className="m51-button"
        label={copyState === "copied" ? "设置话术已复制" : copyState === "manual" ? "已选中，请手动复制" : "复制给 Agent"}
        variant="secondary"
        size="lg"
        icon={copyState === "copied" ? <IconCheck size={17} aria-hidden="true" /> : <IconCopy size={17} aria-hidden="true" />}
        onClick={async () => setCopyState(await copyText(text, sourceRef.current))}
      />
      <p className="m51-copy-status" aria-live="polite">{copyState === "copied"
        ? "现在回到 Agent 对话并发送。"
        : copyState === "manual" ? "浏览器未允许自动复制，设置话术已选中。" : ""}</p>
    </div>
  </Theme>;
}

export function CopySecretIsland({ sourceId, returnPath }: { sourceId: string; returnPath: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  useEffect(() => {
    window.history.replaceState(null, "", returnPath);
    const clearSecret = () => {
      const source = document.getElementById(sourceId);
      if (source) source.textContent = "";
    };
    window.addEventListener("pagehide", clearSecret, { once: true });
    return () => window.removeEventListener("pagehide", clearSecret);
  }, [returnPath, sourceId]);
  return <Theme theme={neutralTheme} mode="light">
    <div className="m51-secret-copy">
      <Button
        className="m51-button"
        label={copyState === "copied" ? "Token 已复制" : copyState === "manual" ? "已选中，请手动复制" : "复制 Token"}
        variant="primary"
        size="lg"
        icon={copyState === "copied" ? <IconCheck size={17} aria-hidden="true" /> : <IconCopy size={17} aria-hidden="true" />}
        onClick={async () => {
          const source = document.getElementById(sourceId);
          const value = source?.textContent ?? "";
          if (value) setCopyState(await copyText(value, source));
        }}
      />
      <p className="m51-copy-status" aria-live="polite">{copyState === "copied"
        ? "Token 已复制。请立即交给刚才索取它的 Agent。"
        : copyState === "manual" ? "浏览器未允许自动复制，Token 已选中。" : ""}</p>
    </div>
  </Theme>;
}

export function LogoutIsland({ basePath }: { basePath: string }) {
  const [state, setState] = useState<FormState>("idle");
  const [message, setMessage] = useState("");
  async function logout() {
    setState("loading");
    setMessage("");
    try {
      const response = await postJson(basePath, "/api/auth/sign-out", {});
      if (!response.ok) {
        setState("error");
        setMessage("当前会话没有退出成功，请稍后重试。");
        return;
      }
      setState("success");
      window.location.assign(`${basePath}/login`);
    } catch {
      setState("error");
      setMessage("网络请求没有完成。请检查连接后重试。");
    }
  }
  return <Theme theme={neutralTheme} mode="light">
    <div className="m51-session-form">
      <Button className="m51-button" label={state === "loading" ? "正在退出" : "退出当前会话"} variant="secondary" size="md" type="button" isLoading={state === "loading"} onClick={logout} />
      <p className={state === "error" ? "m51-field-message is-error" : "m51-field-message"} role={state === "error" ? "alert" : undefined} aria-live="polite">{message}</p>
    </div>
  </Theme>;
}
