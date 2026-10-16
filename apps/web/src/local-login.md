---
title: Local workspace sign in
sidebar: false
---

<div class="landing-page">
  <section class="prose-card" style="max-width: 36rem; margin: 4rem auto">
    <p class="eyebrow">Private workspace</p>
    <h1>Sign in to Team Spaces</h1>
    <p>Enter the access key for this local installation to manage project work.</p>
    <form class="editor-form" method="post" data-local-login>
      <label>Local access key<input name="key" type="password" autocomplete="current-password" required maxlength="1024"></label>
      <button class="button button--primary" type="submit" disabled>Sign in</button>
    </form>
    <p role="status" aria-live="polite" data-login-status>Preparing sign in…</p>
    <p><a href="/projects">Browse public projects</a></p>
  </section>
</div>

```js
import {localSignIn, runtimeConfig} from "./lib/auth.js";

const config = await runtimeConfig();
const form = document.querySelector("[data-local-login]");
const status = document.querySelector("[data-login-status]");
if (!config.localAuth.enabled) {
  form.hidden = true;
  status.textContent = "Local workspace sign in is not enabled for this installation.";
} else {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    if (submit.disabled) return;
    submit.disabled = true;
    status.textContent = "Signing in…";
    try {
      await localSignIn(form.elements.key.value);
      form.elements.key.value = "";
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });
  form.querySelector("button").disabled = false;
  status.textContent = "";
}
```
