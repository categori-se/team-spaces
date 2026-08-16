// @ts-check

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");

function ruleBody(selector, startAt = 0) {
  const selectorIndex = css.indexOf(selector, startAt);
  assert.notEqual(selectorIndex, -1, `Missing CSS selector: ${selector}`);
  const openIndex = css.indexOf("{", selectorIndex + selector.length);
  assert.notEqual(openIndex, -1, `Missing rule body: ${selector}`);
  let depth = 1;
  for (let index = openIndex + 1; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return {body: css.slice(openIndex + 1, index), end: index + 1};
  }
  assert.fail(`Unclosed CSS rule: ${selector}`);
}

function property(body, name) {
  const match = body.match(new RegExp(`${name.replaceAll("-", "\\-")}\\s*:\\s*([^;]+);`));
  assert.ok(match, `Missing ${name}`);
  return match[1].trim();
}

function normalized(value) {
  return value.replace(/\s+/g, " ");
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  assert.match(value, /^[0-9a-f]{6}$/i);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function luminance(hex) {
  return rgbLuminance(hexToRgb(hex));
}

function rgbLuminance(rgb) {
  const channels = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function translucentContrast(foreground, background) {
  const match = foreground.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*(\d*\.?\d+)\)$/);
  assert.ok(match, `Expected rgba color, received ${foreground}`);
  const alpha = Number(match[4]);
  const backdrop = hexToRgb(background);
  const composite = [1, 2, 3].map((index, channel) => Number(match[index]) * alpha + backdrop[channel] * (1 - alpha));
  const lighter = Math.max(rgbLuminance(composite), rgbLuminance(backdrop));
  const darker = Math.min(rgbLuminance(composite), rgbLuminance(backdrop));
  return (lighter + 0.05) / (darker + 0.05);
}

const designSystemStart = css.indexOf("/* Deliberate application visual system");
const light = ruleBody(':root,\n:root[data-theme="light"]', designSystemStart);
const dark = ruleBody(':root[data-theme="dark"]', light.end);
const automaticDark = ruleBody(':root:not([data-theme="light"])', dark.end);

const heroTokens = [
  "--ts-hero-background",
  "--ts-hero-image-opacity",
  "--ts-hero-image-filter",
  "--ts-hero-overlay",
  "--ts-hero-ink",
  "--ts-hero-copy",
  "--ts-hero-note",
  "--ts-hero-eyebrow",
  "--ts-hero-ghost-background",
  "--ts-hero-ghost-border",
  "--ts-hero-ghost-ink",
  "--ts-hero-ghost-hover-background",
  "--ts-hero-ghost-hover-border",
  "--ts-hero-ghost-shadow"
];

test("landing hero has complete light, explicit-dark, and automatic-dark tokens", () => {
  for (const token of heroTokens) {
    assert.notEqual(property(light.body, token), "");
    assert.equal(normalized(property(dark.body, token)), normalized(property(automaticDark.body, token)));
  }
  assert.notEqual(property(light.body, "--ts-hero-overlay"), property(dark.body, "--ts-hero-overlay"));
});

test("landing hero consumes theme tokens after legacy media-query rules", () => {
  const contractStart = css.indexOf("/* Keep a saved landing-page theme authoritative");
  assert.ok(contractStart > css.lastIndexOf("@media (prefers-color-scheme: dark)"));
  for (const declaration of [
    "background: var(--ts-hero-background)",
    "opacity: var(--ts-hero-image-opacity)",
    "filter: var(--ts-hero-image-filter)",
    "background: var(--ts-hero-overlay)",
    "color: var(--ts-hero-ink)",
    "color: var(--ts-hero-copy)",
    "color: var(--ts-hero-note)",
    "color: var(--ts-hero-eyebrow)",
    "background: var(--ts-hero-ghost-background)",
    "border-color: var(--ts-hero-ghost-border)",
    "color: var(--ts-hero-ghost-ink)",
    "background: var(--ts-hero-ghost-hover-background)",
    "border-color: var(--ts-hero-ghost-hover-border)"
  ]) {
    assert.ok(css.indexOf(declaration, contractStart) > contractStart, `Missing final landing declaration: ${declaration}`);
  }
});

test("landing text tokens retain accessible contrast in both themes", () => {
  const lightBackground = property(light.body, "--ts-hero-background");
  const darkBackground = property(dark.body, "--ts-hero-background");
  for (const token of ["--ts-hero-ink", "--ts-hero-copy", "--ts-hero-note", "--ts-hero-eyebrow"]) {
    assert.ok(contrast(property(light.body, token), lightBackground) >= 4.5, `${token} must pass in light mode`);
    assert.ok(contrast(property(dark.body, token), darkBackground) >= 4.5, `${token} must pass in dark mode`);
  }
  assert.ok(contrast("#0969da", property(light.body, "--ts-landing-canvas")) >= 4.5);
  assert.ok(contrast("#59636e", property(light.body, "--ts-landing-canvas")) >= 4.5);
  assert.ok(
    translucentContrast(property(light.body, "--ts-hero-ghost-border"), lightBackground) >= 3,
    "Light secondary-action boundary must remain distinguishable"
  );
});
