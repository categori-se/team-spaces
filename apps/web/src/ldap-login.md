---
title: Directory sign in
sidebar: false
---

<div class="landing-page">
  <section class="prose-card" style="max-width: 36rem; margin: 4rem auto">
    <p class="eyebrow">Secure directory access</p>
    <h1>Sign in with your organization directory</h1>
    <p>Your password is sent only to the Team Spaces authentication endpoint and used for a verified LDAPS bind. It is never stored.</p>
    <form class="editor-form" data-ldap-login>
      <label>Username<input name="username" autocomplete="username" required maxlength="320"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
      <button class="button button--primary" type="submit">Sign in</button>
      <p role="status" aria-live="polite" data-login-status></p>
    </form>
    <p><a href="/">Return to Team Spaces</a></p>
  </section>
</div>

```js
import {ldapSignIn, runtimeConfig} from "./lib/auth.js";

const config = await runtimeConfig();
const form = document.querySelector("[data-ldap-login]");
const status = document.querySelector("[data-login-status]");
if (!config.ldap?.enabled) {
  form.hidden = true;
  status.textContent = "Directory sign in is not enabled for this installation.";
} else {
  document.querySelector("h1").textContent = `Sign in with ${config.ldap.label}`;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    submit.disabled = true;
    status.textContent = "Checking directory credentials...";
    const values = new FormData(form);
    try {
      await ldapSignIn(String(values.get("username") ?? ""), String(values.get("password") ?? ""));
    } catch (error) {
      submit.disabled = false;
      status.textContent = error.message;
    }
  });
}
```
