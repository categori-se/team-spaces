---
title: Team Spaces
sidebar: false
---

<div class="landing-page">
  <section class="hero" aria-labelledby="landing-title">
    <img src="assets/portfolio-hero.png" alt="" class="hero__image">
    <div class="hero__content">
      <p class="eyebrow">Project work, clearly organized</p>
      <h1><span id="landing-title">Team Spaces</span></h1>
      <p class="hero__lede">Bring your team’s projects, tasks, roadmaps and decisions together in one workspace.</p>
      <div class="hero__actions" aria-label="Open project work">
        <a class="button button--primary" href="/app/projects" data-workspace-sign-in>Sign in to your workspace</a>
        <a class="button button--ghost" href="/projects">Browse public projects</a>
        <a class="button button--ghost" href="/ldap-login" data-ldap-sign-in hidden>Directory sign in</a>
      </div>
      <p class="hero__note">Explore published project work, or sign in to manage the projects your team shares with you.</p>
    </div>
  </section>
  <section class="landing-demo" aria-labelledby="platform-work-title">
    <div class="landing-demo__intro">
      <p class="eyebrow">A workspace for every project</p>
      <h2><span id="platform-work-title">Keep teams aligned as projects grow</span></h2>
      <p>Plan delivery, delegate tasks, review progress and connect work across projects. Publish selected projects for people to follow while keeping internal work private.</p>
      <p><a href="/projects">Explore public projects</a></p>
    </div>
    <p class="landing-demo__legal"><small><a href="LICENSE.txt" download>Apache 2.0 license</a> · <a href="THIRD_PARTY_NOTICES.txt" download>Third-party software notices</a></small></p>
  </section>
</div>

```js
import {beginSignIn, currentSession, runtimeConfig} from "./lib/auth.js";
```

```js
const landingConfig = await runtimeConfig();
const workspaceSignIn = document.querySelector("[data-workspace-sign-in]");
const ldapSignIn = document.querySelector("[data-ldap-sign-in]");
const landingSession = await currentSession().catch(() => ({authenticated: false}));
if (landingConfig.ldap?.enabled) {
  ldapSignIn.hidden = false;
  ldapSignIn.textContent = `Sign in with ${landingConfig.ldap.label}`;
}
if (landingSession.authenticated && !["demo", "public-demo"].includes(landingSession.mode)) {
  workspaceSignIn.textContent = "Open workspace";
} else {
  workspaceSignIn.addEventListener("click", async (event) => {
    event.preventDefault();
    if (workspaceSignIn.getAttribute("aria-busy") === "true") return;
    workspaceSignIn.setAttribute("aria-busy", "true");
    workspaceSignIn.textContent = "Opening sign in…";
    try {
      await beginSignIn();
    } catch (error) {
      workspaceSignIn.removeAttribute("aria-busy");
      workspaceSignIn.textContent = "Sign in to your workspace";
      workspaceSignIn.setAttribute("aria-label", error.message ?? "Unable to start sign in");
    }
  });
}
```
