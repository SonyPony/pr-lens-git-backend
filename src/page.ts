import type { Canvas } from "./canvas.ts";
import { imagePath } from "./urls.ts";
import { VERSION } from "./version.ts";

/**
 * The three pages this server serves: `/`, `/c/{id}` and `/c/{id}.svg`.
 *
 * The contract says nothing about any of them. It only asks that the canvas page
 * sit at `/c/{id}`, so that a link pasted into `pr-lens canvas pull` is
 * recognised and its origin taken as the API. Everything below that is this
 * server's own idea of what to show, and deliberately a small one — no fonts, no
 * requests off this origin for anything these pages render, and the one script
 * inline and doing one thing: remembering which theme the reader picked. A page
 * an operator mounted is their own on that last point: it may name pictures
 * wherever it likes, which is why it is served under a policy of its own.
 *
 * The write token never reaches here. It travels in the URL fragment, which the
 * browser sends to no server, so nothing on these pages can leak it.
 */

const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

/** Where the reader's choice is kept, and the three things it may say. */
const THEME_KEY = "pr-lens-theme";

/**
 * The switcher, top right of every page. A radio group rather than three
 * buttons, because that is what it is: one of three, always exactly one.
 *
 * "Auto" is the absence of a choice, not a fourth colour — it hands the page
 * back to `prefers-color-scheme`, which is where it started.
 *
 * A radio group is one tab stop with arrow keys inside it, so the checked button
 * carries the only `tabindex="0"` and the script moves it along with the choice.
 */
const THEMES = `<div class="themes" role="radiogroup" aria-label="Colour theme">
  <button type="button" role="radio" aria-checked="false" tabindex="-1" data-theme-choice="light">Light</button>
  <button type="button" role="radio" aria-checked="false" tabindex="-1" data-theme-choice="dark">Dark</button>
  <button type="button" role="radio" aria-checked="true" tabindex="0" data-theme-choice="auto">Auto</button>
</div>`;

/**
 * Inline in `<head>`, so the attribute is on `<html>` before the first paint and
 * a reader who chose dark never sees a white page flash past.
 *
 * `localStorage` is read inside a `try`: a browser set to refuse storage throws
 * on the read itself, and the page is meant to work there too, just forgetfully.
 */
const THEME_BOOT = `(function(){try{
var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});
if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;
var m=localStorage.getItem("pr-lens-view-mode");
if(m==="canvas"||m==="document")document.documentElement.dataset.viewMode=m;
}catch(e){}
document.documentElement.dataset.js="";})();`;

/**
 * At the end of `<body>`, where the control and the pictures exist.
 *
 * The pictures are the part a stylesheet cannot reach: a `<source media>` is
 * matched against the browser's own `prefers-color-scheme`, which a chosen theme
 * does not change. So the choice is written into the media query itself —
 * `all` to force the dark render, `not all` to rule it out, and the original
 * query back again for auto. Rewriting `media` makes the browser re-pick the
 * source, so one render is fetched, not both.
 *
 * Only the sources this server wrote, which is what `data-theme-dark` marks. A
 * mounted index page may hold pictures of the operator's own, with art-direction
 * queries that mean something else entirely, and rewriting those would be this
 * script editing somebody else's page.
 */
const THEME_WIRING = `(function(){
var root=document.documentElement;
var key=${JSON.stringify(THEME_KEY)};
var buttons=document.querySelectorAll("[data-theme-choice]");
function apply(choice){
  if(choice==="light"||choice==="dark")root.dataset.theme=choice;else delete root.dataset.theme;
  var media=choice==="dark"?"all":choice==="light"?"not all":"(prefers-color-scheme: dark)";
  var sources=document.querySelectorAll("source[data-theme-dark]");
  for(var i=0;i<sources.length;i++)sources[i].media=media;
  for(var j=0;j<buttons.length;j++){
    var on=buttons[j].dataset.themeChoice===choice;
    buttons[j].setAttribute("aria-checked",String(on));
    buttons[j].tabIndex=on?0:-1;
  }
}
var saved;try{saved=localStorage.getItem(key);}catch(e){}
var current=saved==="light"||saved==="dark"?saved:"auto";
apply(current);
for(var k=0;k<buttons.length;k++)buttons[k].addEventListener("click",function(){
  current=this.dataset.themeChoice;
  apply(current);
  try{current==="auto"?localStorage.removeItem(key):localStorage.setItem(key,current);}catch(e){}
});
var group=document.querySelector(".themes");
if(group)group.addEventListener("keydown",function(event){
  var step=event.key==="ArrowRight"||event.key==="ArrowDown"?1:
    event.key==="ArrowLeft"||event.key==="ArrowUp"?-1:0;
  var at=Array.prototype.indexOf.call(buttons,document.activeElement);
  if(step===0||at<0)return;
  event.preventDefault();
  var next=buttons[(at+step+buttons.length)%buttons.length];
  next.focus();
  next.click();
});
})();`;

/**
 * One stylesheet, inline, for both pages. Inline because a second request for a
 * stylesheet is a second thing to cache, invalidate and get wrong, and this is
 * two kilobytes.
 */
const shell = (
  title: string,
  body: string,
  nonce: string,
  topNavExtra?: string,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>
/*
 * Light is the plain reading of :root; dark arrives twice, once for the reader
 * who never touched the switcher and once for the one who chose it. Neither
 * colour is only ever defined inside a query, so a token always has a value.
 */
:root {
  color-scheme: light dark;
  --ink: #1b1b1f;
  --dim: #63636b;
  --page: #fbfbfd;
  --card: #ffffff;
  --edge: #e4e4ea;
  --accent: #6d4aff;
  /* Text on the accent, which is dark once the accent itself is a pale one. */
  --on-accent: #ffffff;
  --tour-fg: #1a7f37;
  --tour-bg: var(--card);
  --tour-border: #1a7f37;
  --tour-hover-bg: #1a7f37;
  --tour-hover-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ink: #ececf1;
    --dim: #9a9aa5;
    --page: #14141a;
    --card: #1c1c24;
    --edge: #2c2c37;
    --accent: #a894ff;
    --on-accent: #14141a;
    --tour-fg: #3fb950;
    --tour-bg: var(--card);
    --tour-border: #3fb950;
    --tour-hover-bg: #3fb950;
    --tour-hover-fg: #14141a;
  }
}
:root[data-theme="dark"] {
  --ink: #ececf1;
  --dim: #9a9aa5;
  --page: #14141a;
  --card: #1c1c24;
  --edge: #2c2c37;
  --accent: #a894ff;
  --on-accent: #14141a;
  --tour-fg: #3fb950;
  --tour-bg: var(--card);
  --tour-border: #3fb950;
  --tour-hover-bg: #3fb950;
  --tour-hover-fg: #14141a;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 3rem 1.25rem 5rem;
  background: var(--page);
  color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .4rem; letter-spacing: -.01em; }
h2 { font-size: 1rem; margin: 0; letter-spacing: -.005em; }
a { color: var(--accent); }
.lede {
  color: var(--dim);
  margin: 0 0 .75rem;
  max-width: 75ch;
  text-wrap: pretty;
  overflow-wrap: break-word;
  line-height: 1.6;
  font-size: 1.05rem;
}
.rev { color: var(--dim); font-size: .8rem; margin: 0 0 2.5rem; font-variant-numeric: tabular-nums; }
figure { margin: 0 0 2.5rem; }
figcaption { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin-bottom: .6rem; }
.meta { color: var(--dim); font-size: .8rem; margin: 0; }
picture { display: block; }
img {
  display: block; width: 100%; height: auto;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 10px;
}
.empty { color: var(--dim); }

/* The index page */
.narrow { max-width: 70ch; }
h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 2.5rem 0 .75rem; }
pre {
  background: var(--card); border: 1px solid var(--edge); border-radius: 10px;
  padding: .9rem 1rem; overflow-x: auto; margin: 0 0 1rem;
  font: .875rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
ul { padding-left: 1.1rem; margin: 0 0 1rem; }
li { margin-bottom: .35rem; }
dl { display: grid; grid-template-columns: auto 1fr; gap: .35rem 1rem; margin: 0; font-size: .9rem; }
dt { color: var(--dim); }
dd { margin: 0; font-variant-numeric: tabular-nums; }
footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--edge); color: var(--dim); font-size: .85rem; }
.warn { border-left: 2px solid var(--accent); padding-left: .9rem; color: var(--dim); }

/*
 * Markdown brings elements the pages written by hand never use. h3 is a section
 * label above, which is wrong for a heading somebody wrote as ###, so inside
 * prose the headings are plain headings again.
 */
.prose h2 { font-size: 1.3rem; margin: 2.25rem 0 .6rem; letter-spacing: -.01em; }
.prose h3 { font-size: 1.05rem; text-transform: none; letter-spacing: -.005em; color: var(--ink); margin: 1.75rem 0 .5rem; }
.prose h4, .prose h5, .prose h6 { font-size: .95rem; margin: 1.5rem 0 .4rem; }
.prose p, .prose ul, .prose ol { margin: 0 0 1rem; }
.prose ol { padding-left: 1.1rem; }
.prose blockquote {
  margin: 0 0 1rem; border-left: 2px solid var(--accent);
  padding-left: .9rem; color: var(--dim);
}
.prose hr { border: 0; border-top: 1px solid var(--edge); margin: 2rem 0; }
.prose table { border-collapse: collapse; width: 100%; margin: 0 0 1rem; font-size: .9rem; display: block; overflow-x: auto; }
.prose th, .prose td { border: 1px solid var(--edge); padding: .4rem .6rem; text-align: left; }
.prose th { color: var(--dim); font-weight: 600; }
.prose img { margin: 0 0 1rem; }
.prose :is(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0; }

/*
 * The top navigation bar hosting view controls, theme switcher, and help button.
 */
.top-nav { display: none; }
:root[data-js] .top-nav {
  display: flex;
  position: fixed;
  top: .75rem;
  right: .75rem;
  z-index: 50;
  isolation: isolate;
  align-items: center;
  gap: .5rem;
}
.themes {
  display: flex;
  gap: .125rem;
  padding: .1875rem;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 999px;
}
.themes button {
  appearance: none;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--dim);
  padding: .3rem .7rem;
  border-radius: 999px;
  font: inherit;
  font-size: .8rem;
  line-height: 1.2;
}
.themes button:hover { color: var(--ink); }
.themes button[aria-checked="true"] { background: var(--accent); color: var(--on-accent); }
.themes button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Provenance metadata */
.provenance {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  align-items: center;
  margin: .35rem 0 .75rem;
  font-size: .875rem;
  line-height: 1.3;
}
.provenance .canvas-header-link {
  font-size: .875rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dim);
  text-decoration: none;
  display: inline-block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.provenance .canvas-header-link:hover {
  color: var(--accent);
  text-decoration: underline;
}

/* Demo mode banner */
.demo-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: .75rem;
  padding: .65rem 1rem;
  margin-bottom: 1.75rem;
  background: var(--card);
  border: 1px solid var(--edge);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  font-size: .875rem;
}
.demo-switch {
  display: inline-flex;
  gap: .25rem;
  background: var(--page);
  padding: .15rem;
  border: 1px solid var(--edge);
  border-radius: 6px;
}
.demo-tab {
  padding: .25rem .6rem;
  color: var(--dim);
  text-decoration: none;
  border-radius: 4px;
  font-size: .8rem;
}
.demo-tab:hover { color: var(--ink); }
.demo-tab.active {
  background: var(--card);
  color: var(--accent);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.demo-lead {
  margin: 1.25rem 0 1.5rem;
  padding: .75rem 1rem;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 8px;
  font-size: .95rem;
}

/* Interactive figure in document view */
figure.interactive-figure {
  position: relative;
  cursor: zoom-in;
  border-radius: 12px;
  padding: .5rem;
  margin-left: -.5rem;
  margin-right: -.5rem;
  transition: background .15s ease, box-shadow .15s ease;
  isolation: isolate;
}
figure.interactive-figure:hover {
  background: var(--card);
  box-shadow: 0 4px 20px rgba(0,0,0,0.06);
}
figure.interactive-figure:hover img {
  border-color: var(--accent);
}
figure.interactive-figure:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.figure-hint {
  display: inline-flex;
  align-items: center;
  gap: .3rem;
  font-size: .75rem;
  color: var(--dim);
  margin-left: auto;
  padding: .15rem .45rem;
  background: var(--page);
  border: 1px solid var(--edge);
  border-radius: 4px;
}

/* Lightbox modal [Variant a] */
dialog.lightbox {
  position: fixed;
  inset: 1.25rem;
  width: calc(100vw - 2.5rem);
  height: calc(100vh - 2.5rem);
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  background: var(--page);
  color: var(--ink);
  border: 1px solid var(--edge);
  border-radius: 12px;
  box-shadow: 0 25px 60px rgba(0,0,0,0.35);
  overflow: hidden;
  display: none;
  flex-direction: column;
  z-index: 100;
  isolation: isolate;
}
dialog.lightbox[open] {
  display: flex;
}
dialog.lightbox::backdrop {
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(4px);
}
.lightbox-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .65rem 1.25rem;
  background: var(--card);
  border-bottom: 1px solid var(--edge);
  gap: 1rem;
  flex-shrink: 0;
  z-index: 2;
  isolation: isolate;
}
.lightbox-title-wrap {
  display: flex;
  align-items: baseline;
  gap: .6rem;
  min-width: 0;
  max-width: calc(50% - 75px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
}
.lightbox-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lightbox-meta {
  font-size: .8rem;
  color: var(--dim);
  flex-shrink: 0;
}
.lightbox-nav {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: .5rem;
  flex-shrink: 0;
  z-index: 3;
}
.lightbox-counter {
  font-size: .8rem;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
  min-width: 4ch;
  text-align: center;
}
.lightbox-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: .4rem;
  flex-shrink: 0;
}
.btn-icon {
  appearance: none;
  border: 1px solid var(--edge);
  background: var(--page);
  color: var(--ink);
  border-radius: 6px;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font: inherit;
  font-size: .875rem;
  transition: background .1s, border-color .1s, color .1s;
}
.btn-icon:hover {
  background: var(--card);
  border-color: var(--accent);
  color: var(--accent);
}
.btn-icon:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.lightbox-stage {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: var(--page);
  cursor: grab;
  user-select: none;
  touch-action: none;
  isolation: isolate;
}
.lightbox-stage.is-dragging {
  cursor: grabbing;
}
.lightbox-canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}
.lightbox-canvas img {
  display: block;
  max-width: none;
  max-height: none;
  width: auto;
  height: auto;
  border: none;
  border-radius: 0;
  background: transparent;
  pointer-events: none;
}
.zoom-pill {
  position: absolute;
  bottom: 1.25rem;
  right: 1.25rem;
  display: inline-flex;
  align-items: center;
  gap: .125rem;
  padding: .1875rem;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  z-index: 10;
  isolation: isolate;
}
.zoom-pill button {
  appearance: none;
  border: 0;
  background: none;
  color: var(--ink);
  cursor: pointer;
  padding: .35rem .65rem;
  border-radius: 999px;
  font: inherit;
  font-size: .8rem;
  font-weight: 500;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.zoom-pill button:hover {
  background: var(--page);
  color: var(--accent);
}
.zoom-pill button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Cheatsheet / Help Modal (?) */
dialog.help-dialog {
  position: fixed;
  inset: 0;
  margin: auto;
  max-width: 380px;
  width: 90vw;
  height: fit-content;
  padding: 0;
  border: 1px solid var(--edge);
  border-radius: 14px;
  background: var(--card);
  color: var(--ink);
  box-shadow: 0 25px 60px rgba(0,0,0,0.4);
  overflow: hidden;
  z-index: 200;
  isolation: isolate;
}
dialog.help-dialog::backdrop {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}
.help-card {
  padding: 1.25rem 1.5rem;
}
.help-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.1rem;
}
.help-title {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -.01em;
}
.help-grid {
  display: flex;
  flex-direction: column;
  gap: .75rem;
  font-size: .875rem;
}
.help-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.help-label {
  color: var(--ink);
}
.help-action {
  color: var(--dim);
  display: inline-flex;
  align-items: center;
  gap: .35rem;
  font-size: .8125rem;
}
.help-keys {
  display: inline-flex;
  gap: .3rem;
  align-items: center;
}
kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.4rem;
  height: 1.4rem;
  padding: 0 .35rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .75rem;
  font-weight: 600;
  background: var(--page);
  border: 1px solid var(--edge);
  border-radius: 4px;
  box-shadow: 0 1px 1px rgba(0,0,0,0.08);
  color: var(--ink);
}
.help-divider {
  height: 1px;
  background: var(--edge);
  margin: .25rem 0;
}
.btn-help-trigger {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid var(--edge);
  background: var(--card);
  color: var(--dim);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: .85rem;
  font-weight: 600;
  line-height: 1;
  flex-shrink: 0;
}
.btn-help-trigger:hover {
  color: var(--ink);
  border-color: var(--accent);
}
/* Document vs Canvas view mode */
:root[data-view-mode="canvas"] main {
  display: none !important;
}
:root:not([data-view-mode="canvas"]) #canvas-workspace {
  display: none !important;
}
/* Mode-aware help dialog shortcuts */
:root:not([data-view-mode="canvas"]) [data-help-mode="canvas"] {
  display: none !important;
}
:root[data-view-mode="canvas"] [data-help-mode="document"] {
  display: none !important;
}

/* View controls and mode switcher in top bar */
.view-controls {
  display: flex;
  align-items: center;
  gap: .5rem;
}
.mode-switch {
  display: flex;
  gap: .125rem;
  padding: .1875rem;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 999px;
}
.mode-switch button {
  appearance: none;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--dim);
  padding: .3rem .65rem;
  border-radius: 999px;
  font: inherit;
  font-size: .8rem;
  line-height: 1.2;
}
.mode-switch button:hover { color: var(--ink); }
.mode-switch button[aria-checked="true"] { background: var(--accent); color: var(--on-accent); font-weight: 500; }
.mode-switch button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Canvas Workspace [Variant b] */
.canvas-workspace {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--page);
  isolation: isolate;
}
.canvas-stage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
  user-select: none;
  touch-action: none;
  background: var(--page);
  isolation: isolate;
}
.canvas-stage.is-dragging {
  cursor: grabbing;
}
.canvas-header-card {
  position: fixed;
  top: max(.9rem, env(safe-area-inset-top, .9rem));
  left: max(.9rem, env(safe-area-inset-left, .9rem));
  z-index: 10;
  isolation: isolate;
  max-width: 440px;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 10px;
  padding: .55rem .85rem;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08);
}
.canvas-header-title {
  font-size: .92rem;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.3;
  margin-bottom: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.canvas-header-sub {
  margin-top: .2rem;
  line-height: 1.25;
  font-size: .8rem;
  color: var(--dim);
  display: flex;
  align-items: center;
  gap: .35rem;
  flex-wrap: wrap;
}
.canvas-header-link {
  font-size: .8rem;
  color: var(--dim);
  text-decoration: none;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  max-width: 100%;
  transition: color .15s ease;
}
.canvas-header-link:hover {
  color: var(--accent);
  text-decoration: underline;
}
.canvas-header-meta {
  font-size: .8rem;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.canvas-header-sep {
  color: var(--dim);
  opacity: .7;
}
.canvas-diagram-container {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}
:root[data-js] .canvas-diagram-container {
  opacity: 0;
  transition: opacity .15s ease;
}
:root[data-js] .canvas-diagram-container.is-ready {
  opacity: 1;
}
.canvas-diagram-container.animate-transform {
  transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes stagePulse {
  0% { box-shadow: 0 0 0 0 var(--accent); }
  50% { box-shadow: 0 0 0 6px rgba(109, 74, 255, 0.35); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.canvas-diagram-container.step-pulse .canvas-caption-pill {
  animation: stagePulse 0.6s ease-out;
}
.canvas-caption-pill {
  display: inline-flex;
  align-items: baseline;
  gap: .5rem;
  padding: .35rem .75rem;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 999px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.08);
  margin-bottom: .6rem;
  user-select: none;
}
.canvas-caption-pill .cap-title {
  font-size: .85rem;
  font-weight: 600;
  color: var(--ink);
}
.canvas-caption-pill .cap-meta {
  font-size: .75rem;
  color: var(--dim);
}
.canvas-diagram-body img {
  display: block;
  max-width: none;
  max-height: none;
  width: auto;
  height: auto;
  border: none;
  border-radius: 12px;
  background: transparent;
  box-shadow: 0 12px 35px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08);
  pointer-events: none;
}

/* Bottom dock */
.canvas-dock {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 6px;
  background: transparent;
  border: none;
  box-shadow: none;
  z-index: 10;
  isolation: isolate;
  max-width: calc(100vw - 192px);
  overflow-x: auto;
  overflow-y: hidden;
}
.dock-item {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 12px;
  cursor: pointer;
  color: var(--ink);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease, opacity .15s ease, transform .15s ease;
  flex-shrink: 0;
  opacity: .8;
}
.dock-item:hover {
  opacity: 1;
  border-color: color-mix(in srgb, var(--ink) 20%, var(--edge));
  background: var(--card);
  box-shadow: 0 4px 14px rgba(0,0,0,0.1);
  transform: translateY(-1px);
}
.dock-item.active, .dock-item[aria-selected="true"] {
  opacity: 1;
  border-color: color-mix(in srgb, var(--ink) 25%, var(--edge));
  background: var(--card);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  transform: translateY(-2px);
}
.dock-item.active .dock-title, .dock-item[aria-selected="true"] .dock-title {
  color: var(--accent);
}
.dock-thumb {
  width: 72px;
  height: 48px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--page);
  border: 1px solid var(--edge);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.dock-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  border: none;
  border-radius: 0;
}
.dock-info {
  display: flex;
  flex-direction: column;
  text-align: left;
}
.dock-title {
  font-size: .875rem;
  font-weight: 600;
  line-height: 1.25;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-lens {
  font-size: .75rem;
  color: var(--dim);
  margin-top: 4px;
}

/* Canvas Zoom Pill - elevated above dock to prevent overlap */
.canvas-zoom-pill {
  position: fixed;
  bottom: 96px;
  right: 24px;
  z-index: 20;
  isolation: isolate;
}

.mode-short { display: none; }
.mode-full { display: inline; }

@media (max-width: 60rem) {
  body { padding: 3.5rem .75rem 3rem; }
  :root[data-js] .top-nav {
    top: max(.35rem, env(safe-area-inset-top, .35rem));
    right: max(.35rem, env(safe-area-inset-right, .35rem));
    gap: .35rem;
  }
  .mode-full { display: none; }
  .mode-short { display: inline; }
  .themes button { min-height: 32px; padding: .25rem .45rem; font-size: .75rem; }
  .mode-switch button { min-height: 32px; padding: .25rem .5rem; font-size: .75rem; }
  .btn-help-trigger { width: 32px; height: 32px; font-size: .85rem; }

  @media (max-width: 30rem) {
    :root[data-js] .top-nav { gap: .2rem; }
    .themes button { padding: .2rem .35rem; font-size: .7rem; }
    .mode-switch button { padding: .2rem .35rem; font-size: .7rem; }
  }

  .canvas-header-card {
    top: max(3.2rem, calc(env(safe-area-inset-top, 0px) + 3.2rem));
    left: max(.5rem, env(safe-area-inset-left, .5rem));
    right: max(.5rem, env(safe-area-inset-right, .5rem));
    max-width: none;
    width: calc(100vw - 1rem);
    padding: .4rem .65rem;
  }
  .canvas-header-title { font-size: .82rem; }
  .canvas-header-sub { margin-top: .15rem; }
  .canvas-header-link { font-size: .75rem; }

  .canvas-dock {
    bottom: max(12px, env(safe-area-inset-bottom, 12px));
    left: max(8px, env(safe-area-inset-left, 8px));
    right: max(8px, env(safe-area-inset-right, 8px));
    transform: none;
    max-width: none;
    width: calc(100vw - 16px);
    padding: 6px 4px;
    gap: 8px;
    -webkit-overflow-scrolling: touch;
    overflow-y: hidden;
  }
  .dock-item { padding: 6px 8px; gap: 8px; border-radius: 8px; }
  .dock-thumb { width: 56px; height: 36px; border-radius: 6px; }
  .dock-title { max-width: 140px; font-size: .8125rem; }
  .dock-lens { font-size: .6875rem; margin-top: 2px; }

  .canvas-zoom-pill {
    bottom: max(80px, calc(env(safe-area-inset-bottom, 0px) + 80px));
    right: max(8px, env(safe-area-inset-right, 8px));
    padding: 4px;
  }
  .zoom-pill button { padding: .25rem .45rem; font-size: .75rem; }

  dialog.lightbox {
    inset: 0;
    width: 100vw;
    height: 100vh;
    border-radius: 0;
    border: none;
  }
  .lightbox-title-wrap { max-width: calc(50% - 55px); }
  .lightbox-title { font-size: .85rem; }
  .lightbox-meta { display: none; }
  .lightbox-nav { gap: .2rem; }
  .lightbox-counter { font-size: .75rem; min-width: 3.5ch; }
  .lightbox-actions { gap: .25rem; }
  .btn-icon { width: 28px; height: 28px; }
  #lightbox .zoom-pill { bottom: .75rem; right: .75rem; }
}
</style>
<script nonce="${nonce}">${THEME_BOOT}</script>
</head>
<body>
<header class="top-nav" id="top-nav" aria-label="Controls">
  ${topNavExtra ?? ""}
  ${THEMES}
</header>
${body}
<script nonce="${nonce}">${THEME_WIRING}</script>
</body>
</html>
`;

/**
 * What the page is allowed to do, which is: show itself.
 *
 * The scripts this server writes are named by a nonce, and nothing else may run
 * — not an inline `<script>` that reached the page some other way, not an
 * `onclick=`, not a `javascript:` link. That is the guarantee behind letting an
 * operator write raw HTML into their own index page: their HTML is theirs, but
 * it is not code.
 *
 * `images` is the one thing that differs between the two kinds of page. A page
 * this server wrote shows pictures from this server; a page an operator wrote
 * may well point at their intranet's logo, and breaking that to no purpose would
 * be a policy about nothing. Styles stay `unsafe-inline`, since that is what an
 * inline `style=` attribute needs and a stylesheet cannot execute anything.
 */
export const pageCsp = (nonce: string, images: "self" | "anywhere"): string =>
  [
    "default-src 'none'",
    images === "self" ? "img-src 'self'" : "img-src * data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

/** The tile the embed shows, which the contract fixes as the first one. */
export const heroOf = (canvas: Canvas) =>
  canvas.drawing.tiles.find((tile) => tile.hero) ?? canvas.drawing.tiles[0];

export const heroSvg = (
  canvas: Canvas,
  theme: "light" | "dark",
): { svg: string; contentHash: string } | undefined => {
  const hero = heroOf(canvas);
  if (hero === undefined) return undefined;

  const fileName = hero.files[theme] ?? hero.files.light;
  const contentHash = hero.renders[theme] ?? hero.renders.light;
  if (fileName === undefined || contentHash === undefined) return undefined;

  const svg = canvas.drawing.images.get(fileName);
  return svg === undefined ? undefined : { svg, contentHash };
};


/**
 * A `<picture>` per tile: the dark render behind a media query, the light one as
 * the fallback. Which means the page follows the reader's system theme on its
 * own, and the switcher only has to edit that one media query to override it.
 *
 * The addresses are paths rather than URLs, so they are this origin by
 * construction — whatever the reader typed, and whatever `PUBLIC_URL` says.
 */
const tileFigure = (
  id: string,
  tile: Canvas["drawing"]["tiles"][number],
  index: number,
): string => {
  const light = tile.files.light;
  const dark = tile.files.dark;
  if (light === undefined) return "";

  const trail = tile.crumbs.length > 1 ? tile.crumbs.join(" / ") : "";

  return `<figure class="interactive-figure" data-diagram-index="${index}" tabindex="0" role="button" aria-label="Open diagram ${escape(tile.title)} in interactive viewer">
  <figcaption>
    <h2>${escape(tile.title)}</h2>
    <p class="meta">${escape(tile.lens)}${trail === "" ? "" : ` &middot; ${escape(trail)}`}</p>
    <span class="figure-hint" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z"/></svg>
      <span>Interactive</span>
    </span>
  </figcaption>
  <picture>
    ${dark === undefined ? "" : `<source srcset="${escape(imagePath(id, dark))}" media="(prefers-color-scheme: dark)" data-theme-dark>`}
    <img src="${escape(imagePath(id, light))}" width="${tile.width}" height="${tile.height}" alt="${escape(tile.title)}" loading="lazy">
  </picture>
</figure>`;
};

const LIGHTBOX_HTML = `<dialog class="lightbox" id="lightbox" aria-label="Diagram viewer">
  <div class="lightbox-header">
    <div class="lightbox-title-wrap">
      <span class="lightbox-title" id="lightbox-title"></span>
      <span class="lightbox-meta" id="lightbox-meta"></span>
    </div>
    <div class="lightbox-nav">
      <button type="button" class="btn-icon" id="lb-prev" aria-label="Previous diagram (←)" title="Previous (←)">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"/></svg>
      </button>
      <span class="lightbox-counter" id="lb-counter">1 / 1</span>
      <button type="button" class="btn-icon" id="lb-next" aria-label="Next diagram (→)" title="Next (→)">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>
      </button>
    </div>
    <div class="lightbox-actions">
      <button type="button" class="btn-icon" id="lb-help-btn" aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)">?</button>
      <button type="button" class="btn-icon" id="lb-close" aria-label="Close dialog (Esc)" title="Close (Esc)">✕</button>
    </div>
  </div>
  <div class="lightbox-stage" id="lightbox-stage">
    <div class="lightbox-canvas" id="lightbox-canvas"></div>
  </div>
  <div class="zoom-pill" id="lb-zoom-pill" role="toolbar" aria-label="Zoom controls">
    <button type="button" id="lb-zoom-out" title="Zoom out (-)" aria-label="Zoom out">−</button>
    <button type="button" id="lb-zoom-reset" title="Zoom to 100% (0)" aria-label="Reset zoom to 100%">100%</button>
    <button type="button" id="lb-zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
    <button type="button" id="lb-zoom-fit" title="Fit to screen (1)" aria-label="Fit diagram">Fit</button>
  </div>
</dialog>`;

const HELP_DIALOG_HTML = `<dialog class="help-dialog" id="help-dialog" aria-label="Keyboard shortcuts and gestures">
  <div class="help-card">
    <div class="help-header">
      <span class="help-title">Shortcuts &amp; Gestures</span>
      <button type="button" class="btn-icon" id="help-close" aria-label="Close cheatsheet">✕</button>
    </div>
    <div class="help-grid">
      <!-- Document reading mode shortcuts -->
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Open interactive viewer</span>
        <span class="help-action">click diagram figure</span>
      </div>
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Zoom viewer</span>
        <span class="help-action">scroll or pinch</span>
      </div>
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Pan viewer</span>
        <span class="help-action">drag</span>
      </div>
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Smooth zoom in</span>
        <span class="help-action">double-click</span>
      </div>
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Previous, next diagram</span>
        <span class="help-keys"><kbd>←</kbd> <kbd>→</kbd></span>
      </div>
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Fit diagram / 100%</span>
        <span class="help-keys"><kbd>1</kbd> / <kbd>0</kbd></span>
      </div>
      <div class="help-row" data-help-mode="document">
        <span class="help-label">Close viewer</span>
        <span class="help-keys"><kbd>Esc</kbd></span>
      </div>

      <!-- Canvas workspace mode shortcuts -->
      <div class="help-row" data-help-mode="canvas">
        <span class="help-label">Pan canvas</span>
        <span class="help-action">drag background</span>
      </div>
      <div class="help-row" data-help-mode="canvas">
        <span class="help-label">Zoom canvas</span>
        <span class="help-action">scroll or pinch</span>
      </div>
      <div class="help-row" data-help-mode="canvas">
        <span class="help-label">Smooth zoom in</span>
        <span class="help-action">double-click</span>
      </div>
      <div class="help-row" data-help-mode="canvas">
        <span class="help-label">Switch diagram</span>
        <span class="help-action">click dock or card</span>
      </div>
      <div class="help-row" data-help-mode="canvas">
        <span class="help-label">Previous, next diagram</span>
        <span class="help-keys"><kbd>←</kbd> <kbd>→</kbd></span>
      </div>
      <div class="help-row" data-help-mode="canvas">
        <span class="help-label">Fit diagram / 100%</span>
        <span class="help-keys"><kbd>1</kbd> / <kbd>0</kbd></span>
      </div>
    </div>
  </div>
</dialog>`;

export type ProvenanceInfo = {
  mrTitle: string;
  row2Content: string;
};

export const resolveProvenanceInfo = (
  canvasId: string,
  title: string,
  provenance?: any,
): ProvenanceInfo => {
  // Row 1: full MR title
  const mrTitle = provenance?.pullRequest?.title || title || canvasId;

  // Row 2: link to MR as owner/projekt #mr (with basic fallbacks if info is missing)
  const repo = provenance?.repo?.owner && provenance?.repo?.name
    ? `${provenance.repo.owner}/${provenance.repo.name}`
    : undefined;
  const pr = provenance?.pullRequest;
  const branch = provenance?.head?.ref;

  let row2Content = "";
  if (repo && pr?.number) {
    const text = `${repo} #${pr.number}`;
    row2Content = pr.url
      ? `<a class="canvas-header-link" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer" title="${escape(mrTitle)}">${escape(text)}</a>`
      : `<span class="canvas-header-link">${escape(text)}</span>`;
  } else if (repo && branch) {
    row2Content = `<span class="canvas-header-link">${escape(repo)} (${escape(branch)})</span>`;
  } else if (repo) {
    row2Content = `<span class="canvas-header-link">${escape(repo)}</span>`;
  } else if (pr?.number) {
    const text = `#${pr.number}`;
    row2Content = pr.url
      ? `<a class="canvas-header-link" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer" title="${escape(mrTitle)}">${escape(text)}</a>`
      : `<span class="canvas-header-link">${escape(text)}</span>`;
  } else if (branch) {
    row2Content = `<span class="canvas-header-link">${escape(branch)}</span>`;
  }

  return { mrTitle, row2Content };
};

const canvasHeaderCardHtml = (
  canvasId: string,
  title: string,
  provenance: NonNullable<Canvas["document"]>["provenance"] | undefined,
  rev?: number,
  tileCount?: number,
): string => {
  const { mrTitle, row2Content } = resolveProvenanceInfo(canvasId, title, provenance);

  const parts: string[] = [];
  if (row2Content) {
    parts.push(row2Content);
  }
  if (rev !== undefined && tileCount !== undefined) {
    parts.push(`<span class="canvas-header-meta">Revision ${rev} &middot; ${tileCount} diagram${tileCount === 1 ? "" : "s"}</span>`);
  }

  const subContent = parts.length > 0
    ? `<div class="canvas-header-sub">${parts.join(` <span class="canvas-header-sep">&middot;</span> `)}</div>`
    : "";

  return `<div class="canvas-header-card">
    <div class="canvas-header-title" title="${escape(mrTitle)}">${escape(mrTitle)}</div>
    ${subContent}
  </div>`;
};

const canvasWorkspaceHtml = (
  canvasId: string,
  title: string,
  provenance: NonNullable<Canvas["document"]>["provenance"] | undefined,
  tiles: Canvas["drawing"]["tiles"],
  rev?: number,
): string => {
  const first = tiles[0];
  if (first === undefined) return "";
  const firstTrail = first.crumbs.length > 1 ? first.crumbs.join(" / ") : "";

  return `<div class="canvas-workspace" id="canvas-workspace" aria-label="Canvas workspace">
  ${canvasHeaderCardHtml(canvasId, title, provenance, rev, tiles.length)}

  <div class="canvas-stage" id="canvas-stage">
    <div class="canvas-diagram-container" id="canvas-diagram-container">
      <div class="canvas-caption-pill" id="canvas-caption-pill">
        <span class="cap-title" id="cv-cap-title">${escape(first.title)}</span>
        <span class="cap-meta" id="cv-cap-meta">${escape(first.lens)}${firstTrail ? ` &middot; ${escape(firstTrail)}` : ""}</span>
      </div>
      <div class="canvas-diagram-body" id="canvas-diagram-body">
        <picture>
          ${first.files.dark ? `<source srcset="${escape(imagePath(canvasId, first.files.dark))}" media="(prefers-color-scheme: dark)" data-theme-dark>` : ""}
          <img src="${escape(imagePath(canvasId, first.files.light ?? ""))}" width="${first.width}" height="${first.height}" alt="${escape(first.title)}" draggable="false">
        </picture>
      </div>
    </div>
  </div>

  <div class="canvas-dock" id="canvas-dock" role="tablist" aria-label="Diagrams thumbnail switcher">
    ${tiles
      .map(
        (tile, idx) => `
      <button type="button" class="dock-item${idx === 0 ? " active" : ""}" role="tab" data-dock-index="${idx}" aria-selected="${idx === 0 ? "true" : "false"}" title="${escape(tile.title)}">
        <span class="dock-thumb">
          <picture>
            ${tile.files.dark ? `<source srcset="${escape(imagePath(canvasId, tile.files.dark))}" media="(prefers-color-scheme: dark)" data-theme-dark>` : ""}
            <img src="${escape(imagePath(canvasId, tile.files.light ?? ""))}" width="${tile.width}" height="${tile.height}" alt="${escape(tile.title)}" loading="lazy">
          </picture>
        </span>
        <span class="dock-info">
          <span class="dock-title">${escape(tile.title)}</span>
          <span class="dock-lens">${escape(tile.lens)}</span>
        </span>
      </button>`,
      )
      .join("\n")}
  </div>

  <div class="zoom-pill canvas-zoom-pill" id="canvas-zoom-pill" role="toolbar" aria-label="Canvas zoom controls">
    <button type="button" id="cv-zoom-out" title="Zoom out (-)" aria-label="Zoom out">−</button>
    <button type="button" id="cv-zoom-reset" title="Zoom to 100% (0)" aria-label="Reset zoom to 100%">100%</button>
    <button type="button" id="cv-zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
    <button type="button" id="cv-zoom-fit" title="Fit to screen (1)" aria-label="Fit diagram">Fit</button>
  </div>
</div>`;
};

const INTERACTIVE_WIRING = `(function(){
var dataTag = document.getElementById("pr-lens-data") || document.getElementById("pr-lens-tiles");
if (!dataTag) return;
var parsed = JSON.parse(dataTag.textContent || "{}");
var tiles = Array.isArray(parsed) ? parsed : (parsed.tiles || []);
if (!tiles.length) return;

var VIEW_KEY = "pr-lens-view-mode";
var currentMode = document.documentElement.dataset.viewMode || "document";
var modeButtons = document.querySelectorAll("[data-mode-choice]");

function applyMode(mode) {
  currentMode = mode;
  document.documentElement.dataset.viewMode = mode;
  for (var i = 0; i < modeButtons.length; i++) {
    var on = modeButtons[i].dataset.modeChoice === mode;
    modeButtons[i].setAttribute("aria-checked", String(on));
    modeButtons[i].tabIndex = on ? 0 : -1;
  }
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch(e) {}
  if (mode === "canvas") {
    if (cvCtrl) {
      fitCanvas(1.0, true);
      if (cvContainer) cvContainer.classList.add("is-ready");
    }
  }
}

applyMode(currentMode);
for (var mb = 0; mb < modeButtons.length; mb++) {
  modeButtons[mb].addEventListener("click", function() {
    applyMode(this.dataset.modeChoice);
  });
}

var lb = document.getElementById("lightbox");
var lbStage = document.getElementById("lightbox-stage");
var lbCanvas = document.getElementById("lightbox-canvas");
var lbTitle = document.getElementById("lightbox-title");
var lbMeta = document.getElementById("lightbox-meta");
var lbCounter = document.getElementById("lb-counter");
var lbPrev = document.getElementById("lb-prev");
var lbNext = document.getElementById("lb-next");
var lbClose = document.getElementById("lb-close");
var lbHelp = document.getElementById("lb-help-btn");
var helpDialog = document.getElementById("help-dialog");
var helpClose = document.getElementById("help-close");
var pageHelpBtn = document.getElementById("page-help-btn");
var lbZoomIn = document.getElementById("lb-zoom-in");
var lbZoomOut = document.getElementById("lb-zoom-out");
var lbZoomReset = document.getElementById("lb-zoom-reset");
var lbZoomFit = document.getElementById("lb-zoom-fit");

var lbIndex = 0;
var lbTransform = { x: 0, y: 0, scale: 1.0 };
var lastActiveElement = null;

function applyLbTransform() {
  if (!lbCanvas) return;
  lbCanvas.style.transform = "translate(" + Math.round(lbTransform.x) + "px, " + Math.round(lbTransform.y) + "px) scale(" + lbTransform.scale + ")";
  if (lbZoomReset) {
    lbZoomReset.textContent = Math.round(lbTransform.scale * 100) + "%";
  }
}

function wirePanZoom(stageEl, getTransform, applyFn) {
  if (!stageEl) return null;
  var current = getTransform();
  var target = { x: current.x, y: current.y, scale: current.scale };
  var animId = null;
  var lastTime = 0;

  function stopAnimation() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    lastTime = 0;
  }

  function syncTarget() {
    stopAnimation();
    target.x = current.x;
    target.y = current.y;
    target.scale = current.scale;
  }

  function tick(now) {
    if (!lastTime) lastTime = now;
    var dt = Math.min(64, Math.max(1, now - lastTime)) / 1000;
    lastTime = now;

    var factor = 1 - Math.exp(-22 * dt);

    var scaleDiff = target.scale - current.scale;
    var xDiff = target.x - current.x;
    var yDiff = target.y - current.y;

    if (Math.abs(scaleDiff) < 0.0006 && Math.abs(xDiff) < 0.25 && Math.abs(yDiff) < 0.25) {
      current.scale = target.scale;
      current.x = target.x;
      current.y = target.y;
      applyFn();
      stopAnimation();
      return;
    }

    current.scale += scaleDiff * factor;
    current.x += xDiff * factor;
    current.y += yDiff * factor;
    applyFn();

    animId = requestAnimationFrame(tick);
  }

  function startAnimation() {
    if (!animId) {
      lastTime = 0;
      animId = requestAnimationFrame(tick);
    }
  }

  function smoothZoomAt(newScale, cx, cy) {
    newScale = Math.min(Math.max(newScale, 0.05), 5.0);
    var ratio = newScale / target.scale;
    target.x = cx - (cx - target.x) * ratio;
    target.y = cy - (cy - target.y) * ratio;
    target.scale = newScale;
    startAnimation();
  }

  function smoothMoveTo(destScale, destX, destY) {
    destScale = Math.min(Math.max(destScale, 0.05), 5.0);
    target.scale = destScale;
    target.x = destX;
    target.y = destY;
    startAnimation();
  }

  function instantMoveTo(destScale, destX, destY) {
    stopAnimation();
    destScale = Math.min(Math.max(destScale, 0.05), 5.0);
    current.scale = target.scale = destScale;
    current.x = target.x = destX;
    current.y = target.y = destY;
    applyFn();
  }

  var activePointers = new Map();
  var initialDist = 0;
  var initialScale = 1;
  var isDragging = false;
  var dragStart = { x: 0, y: 0 };
  var startPos = { x: 0, y: 0 };

  stageEl.addEventListener("pointerdown", function(e) {
    if (cvContainer) cvContainer.classList.remove("animate-transform");
    stopAnimation();
    target.x = current.x;
    target.y = current.y;
    target.scale = current.scale;

    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1 && e.button === 0) {
      isDragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      startPos = { x: current.x, y: current.y };
      stageEl.setPointerCapture(e.pointerId);
      stageEl.classList.add("is-dragging");
    } else if (activePointers.size === 2) {
      isDragging = false;
      stageEl.classList.remove("is-dragging");
      var pts = Array.from(activePointers.values());
      initialDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      initialScale = current.scale;
    }
  });

  stageEl.addEventListener("pointermove", function(e) {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (activePointers.size === 2 && initialDist > 0) {
      var pts = Array.from(activePointers.values());
      var currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var rect = stageEl.getBoundingClientRect();
      var midX = (pts[0].x + pts[1].x) / 2 - rect.left;
      var midY = (pts[0].y + pts[1].y) / 2 - rect.top;
      var newScale = Math.min(Math.max(initialScale * (currentDist / initialDist), 0.05), 5.0);
      var ratio = newScale / current.scale;
      current.x = midX - (midX - current.x) * ratio;
      current.y = midY - (midY - current.y) * ratio;
      current.scale = newScale;
      target.x = current.x;
      target.y = current.y;
      target.scale = current.scale;
      applyFn();
    } else if (isDragging && activePointers.size === 1) {
      current.x = startPos.x + (e.clientX - dragStart.x);
      current.y = startPos.y + (e.clientY - dragStart.y);
      target.x = current.x;
      target.y = current.y;
      applyFn();
    }
  });

  function removePointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) initialDist = 0;
    if (activePointers.size === 0) {
      isDragging = false;
      stageEl.classList.remove("is-dragging");
      try { stageEl.releasePointerCapture(e.pointerId); } catch(err) {}
    }
  }
  stageEl.addEventListener("pointerup", removePointer);
  stageEl.addEventListener("pointercancel", removePointer);

  stageEl.addEventListener("wheel", function(e) {
    e.preventDefault();
    var rect = stageEl.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;
    var factor;
    if (e.ctrlKey) {
      factor = Math.exp(-e.deltaY * 0.015);
    } else if (e.deltaMode === 1 || Math.abs(e.deltaY) >= 30) {
      factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    } else {
      factor = Math.exp(-e.deltaY * 0.005);
    }
    smoothZoomAt(target.scale * factor, cx, cy);
  }, { passive: false });

  stageEl.addEventListener("dblclick", function(e) {
    var rect = stageEl.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;
    smoothZoomAt(target.scale * 1.5, cx, cy);
  });

  function fitContent(contentW, contentH, opts) {
    opts = opts || {};
    var multiplier = typeof opts.multiplier === "number" && !isNaN(opts.multiplier) ? opts.multiplier : 1.0;
    var stageW = stageEl.clientWidth || window.innerWidth;
    var stageH = stageEl.clientHeight || window.innerHeight;
    if (!contentW || !contentH) return;

    var padX = opts.padX || 32;
    var topMargin = typeof opts.topMargin === "number" ? opts.topMargin : padX;
    var bottomMargin = typeof opts.bottomMargin === "number" ? opts.bottomMargin : padX;
    var maxScale = opts.maxScale || 1.5;

    var availW = Math.max(100, stageW - padX * 2);
    var availH = Math.max(100, stageH - topMargin - bottomMargin);

    var fitScale = Math.min(availW / contentW, availH / contentH, maxScale) * multiplier;
    if (isNaN(fitScale) || fitScale <= 0) fitScale = 1.0;

    var destX = (stageW - contentW * fitScale) / 2;
    var destY = topMargin + (availH - contentH * fitScale) / 2;

    if (opts.instant) instantMoveTo(fitScale, destX, destY);
    else smoothMoveTo(fitScale, destX, destY);
  }

  function reset100(contentW, contentH, instant, destY) {
    var stageW = stageEl.clientWidth || window.innerWidth;
    var stageH = stageEl.clientHeight || window.innerHeight;
    var destX = (stageW - contentW) / 2;
    if (typeof destY !== "number") destY = (stageH - contentH) / 2;
    if (instant) instantMoveTo(1.0, destX, destY);
    else smoothMoveTo(1.0, destX, destY);
  }

  return {
    smoothZoomAt: smoothZoomAt,
    smoothMoveTo: smoothMoveTo,
    instantMoveTo: instantMoveTo,
    syncTarget: syncTarget,
    stopAnimation: stopAnimation,
    fitContent: fitContent,
    reset100: reset100,
    getTarget: function() { return target; },
    getCurrent: function() { return current; }
  };
}

var lbCtrl = wirePanZoom(lbStage, function() { return lbTransform; }, applyLbTransform);

function fitLbDiagram(multiplier, instant) {
  var tile = tiles[lbIndex];
  if (!lbStage || !tile || !lbCtrl) return;
  var isMobile = (lbStage.clientWidth || window.innerWidth) < 768;
  lbCtrl.fitContent(tile.width, tile.height, {
    padX: isMobile ? 16 : 32,
    multiplier: multiplier,
    instant: instant,
    maxScale: 1.5
  });
}

function resetLb100(instant) {
  var tile = tiles[lbIndex];
  if (!tile || !lbCtrl) return;
  lbCtrl.reset100(tile.width, tile.height, instant);
}

function zoomLbAt(newScale, cx, cy) {
  if (lbCtrl) lbCtrl.smoothZoomAt(newScale, cx, cy);
}

function renderTilePicture(tile) {
  if (!tile) return "";
  var theme = document.documentElement.dataset.theme;
  var media = theme === "dark" ? "all" : theme === "light" ? "not all" : "(prefers-color-scheme: dark)";
  var sourceHtml = tile.files.dark ? '<source srcset="' + tile.files.dark + '" media="' + media + '" data-theme-dark>' : '';
  return '<picture>' + sourceHtml + '<img src="' + tile.files.light + '" width="' + tile.width + '" height="' + tile.height + '" alt="' + tile.title + '" draggable="false"></picture>';
}

function showLbDiagram(index) {
  if (index < 0) index = tiles.length - 1;
  if (index >= tiles.length) index = 0;
  lbIndex = index;
  var tile = tiles[lbIndex];

  if (lbTitle) lbTitle.textContent = tile.title;
  var trail = tile.crumbs.length > 1 ? tile.crumbs.join(" / ") : "";
  if (lbMeta) lbMeta.textContent = tile.lens + (trail ? " · " + trail : "");
  if (lbCounter) lbCounter.textContent = (lbIndex + 1) + " / " + tiles.length;

  if (lbCanvas) {
    lbCanvas.innerHTML = renderTilePicture(tile);
  }

  requestAnimationFrame(function() {
    fitLbDiagram(1.0, true);
  });
}

function openLightbox(index) {
  lastActiveElement = document.activeElement;
  if (lb) lb.showModal();
  showLbDiagram(index);
}

function closeLightbox() {
  if (lb && lb.open) lb.close();
  if (lastActiveElement && typeof lastActiveElement.focus === "function") {
    lastActiveElement.focus();
  }
}

if (lb) {
  lb.addEventListener("close", function() {
    if (lastActiveElement && typeof lastActiveElement.focus === "function") {
      lastActiveElement.focus();
    }
  });
  lb.addEventListener("click", function(e) {
    if (e.target === lb) closeLightbox();
  });
}

var figures = document.querySelectorAll("figure.interactive-figure");
for (var f = 0; f < figures.length; f++) {
  (function(fig) {
    fig.addEventListener("click", function() {
      var idx = parseInt(fig.dataset.diagramIndex, 10);
      if (!isNaN(idx)) openLightbox(idx);
    });
    fig.addEventListener("keydown", function(e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        var idx = parseInt(fig.dataset.diagramIndex, 10);
        if (!isNaN(idx)) openLightbox(idx);
      }
    });
  })(figures[f]);
}

if (lbPrev) lbPrev.addEventListener("click", function() { showLbDiagram(lbIndex - 1); });
if (lbNext) lbNext.addEventListener("click", function() { showLbDiagram(lbIndex + 1); });
if (lbClose) lbClose.addEventListener("click", closeLightbox);
if (lbHelp) lbHelp.addEventListener("click", function() { if (helpDialog) helpDialog.showModal(); });
if (pageHelpBtn) pageHelpBtn.addEventListener("click", function() { if (helpDialog) helpDialog.showModal(); });

if (helpClose) helpClose.addEventListener("click", function() { if (helpDialog) helpDialog.close(); });
if (helpDialog) helpDialog.addEventListener("click", function(e) { if (e.target === helpDialog) helpDialog.close(); });

if (lbZoomIn) lbZoomIn.addEventListener("click", function() {
  var t = lbCtrl ? lbCtrl.getTarget() : lbTransform;
  zoomLbAt(t.scale * 1.25, lbStage.clientWidth / 2, lbStage.clientHeight / 2);
});
if (lbZoomOut) lbZoomOut.addEventListener("click", function() {
  var t = lbCtrl ? lbCtrl.getTarget() : lbTransform;
  zoomLbAt(t.scale / 1.25, lbStage.clientWidth / 2, lbStage.clientHeight / 2);
});
if (lbZoomReset) lbZoomReset.addEventListener("click", function() { resetLb100(false); });
if (lbZoomFit) lbZoomFit.addEventListener("click", function() { fitLbDiagram(1.0, false); });

var cvStage = document.getElementById("canvas-stage");
var cvContainer = document.getElementById("canvas-diagram-container");
var cvBody = document.getElementById("canvas-diagram-body");
var cvCapTitle = document.getElementById("cv-cap-title");
var cvCapMeta = document.getElementById("cv-cap-meta");
var cvZoomIn = document.getElementById("cv-zoom-in");
var cvZoomOut = document.getElementById("cv-zoom-out");
var cvZoomReset = document.getElementById("cv-zoom-reset");
var cvZoomFit = document.getElementById("cv-zoom-fit");
var dockItems = document.querySelectorAll(".dock-item");

var cvIndex = 0;
var cvTransform = { x: 0, y: 0, scale: 1.0 };

function applyCvTransform() {
  if (!cvContainer) return;
  cvContainer.style.transform = "translate(" + Math.round(cvTransform.x) + "px, " + Math.round(cvTransform.y) + "px) scale(" + cvTransform.scale + ")";
  if (cvZoomReset) {
    cvZoomReset.textContent = Math.round(cvTransform.scale * 100) + "%";
  }
}

var cvCtrl = wirePanZoom(cvStage, function() { return cvTransform; }, applyCvTransform);
if (currentMode === "canvas") {
  fitCanvas(1.0, true);
  if (cvContainer) cvContainer.classList.add("is-ready");
}

function fitCanvas(multiplier, instant) {
  var tile = tiles[cvIndex];
  if (!cvStage || !tile || !cvCtrl) return;
  var stageW = cvStage.clientWidth || window.innerWidth;
  var isMobile = stageW < 768;
  var topMargin = isMobile ? 80 : 96;
  var bottomMargin = isMobile ? 80 : 100;
  var padX = isMobile ? 16 : 48;
  var captionH = 44;
  var totalH = tile.height + captionH;
  cvCtrl.fitContent(tile.width, totalH, {
    padX: padX,
    topMargin: topMargin,
    bottomMargin: bottomMargin,
    multiplier: multiplier,
    instant: instant !== undefined ? instant : true,
    maxScale: 1.0
  });
}

function resetCv100(instant) {
  var tile = tiles[cvIndex];
  if (!tile || !cvCtrl) return;
  var stageH = cvStage.clientHeight || window.innerHeight;
  var destY = Math.max(40, (stageH - (tile.height + 44) - 40) / 2);
  cvCtrl.reset100(tile.width, tile.height, instant, destY);
}

function zoomCvAt(newScale, cx, cy) {
  if (cvCtrl) cvCtrl.smoothZoomAt(newScale, cx, cy);
}

function showCanvasDiagram(index) {
  if (index < 0) index = tiles.length - 1;
  if (index >= tiles.length) index = 0;
  cvIndex = index;
  var tile = tiles[cvIndex];

  if (cvCapTitle) cvCapTitle.textContent = tile.title;
  var trail = tile.crumbs.length > 1 ? tile.crumbs.join(" / ") : "";
  if (cvCapMeta) cvCapMeta.textContent = tile.lens + (trail ? " · " + trail : "");

  for (var d = 0; d < dockItems.length; d++) {
    var isSel = parseInt(dockItems[d].dataset.dockIndex, 10) === cvIndex;
    dockItems[d].classList.toggle("active", isSel);
    dockItems[d].setAttribute("aria-selected", String(isSel));
  }

  if (cvBody) {
    cvBody.innerHTML = renderTilePicture(tile);
  }

  fitCanvas(1.0, true);
}

if (cvZoomIn) cvZoomIn.addEventListener("click", function() {
  var t = cvCtrl ? cvCtrl.getTarget() : cvTransform;
  zoomCvAt(t.scale * 1.25, cvStage.clientWidth / 2, cvStage.clientHeight / 2);
});
if (cvZoomOut) cvZoomOut.addEventListener("click", function() {
  var t = cvCtrl ? cvCtrl.getTarget() : cvTransform;
  zoomCvAt(t.scale / 1.25, cvStage.clientWidth / 2, cvStage.clientHeight / 2);
});
if (cvZoomReset) cvZoomReset.addEventListener("click", function() { resetCv100(false); });
if (cvZoomFit) cvZoomFit.addEventListener("click", function() { fitCanvas(1.0, false); });

for (var dk = 0; dk < dockItems.length; dk++) {
  (function(item) {
    item.addEventListener("click", function() {
      var idx = parseInt(item.dataset.dockIndex, 10);
      if (!isNaN(idx)) showCanvasDiagram(idx);
    });
  })(dockItems[dk]);
}

window.addEventListener("resize", function() {
  if (lb && lb.open) fitLbDiagram(1.0, true);
  if (currentMode === "canvas") fitCanvas(1.0, true);
});

window.addEventListener("keydown", function(e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  if (e.key === "?" || (e.shiftKey && e.key === "?")) {
    e.preventDefault();
    if (helpDialog) {
      if (helpDialog.open) helpDialog.close();
      else helpDialog.showModal();
    }
    return;
  }

  if (e.key === "Escape") {
    if (helpDialog && helpDialog.open) {
      helpDialog.close();
      return;
    }
    if (lb && lb.open) {
      closeLightbox();
      return;
    }
  }

  var activeViewer = lb && lb.open
    ? { ctrl: lbCtrl, stage: lbStage, show: showLbDiagram, getIndex: function() { return lbIndex; }, reset: resetLb100, fit: fitLbDiagram }
    : currentMode === "canvas"
      ? { ctrl: cvCtrl, stage: cvStage, show: showCanvasDiagram, getIndex: function() { return cvIndex; }, reset: resetCv100, fit: fitCanvas }
      : null;

  if (activeViewer) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      activeViewer.show(activeViewer.getIndex() - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      activeViewer.show(activeViewer.getIndex() + 1);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      if (activeViewer.ctrl && activeViewer.stage) {
        var t = activeViewer.ctrl.getTarget();
        activeViewer.ctrl.smoothZoomAt(t.scale * 1.25, activeViewer.stage.clientWidth / 2, activeViewer.stage.clientHeight / 2);
      }
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      if (activeViewer.ctrl && activeViewer.stage) {
        var t = activeViewer.ctrl.getTarget();
        activeViewer.ctrl.smoothZoomAt(t.scale / 1.25, activeViewer.stage.clientWidth / 2, activeViewer.stage.clientHeight / 2);
      }
    } else if (e.key === "0") {
      e.preventDefault();
      activeViewer.reset(false);
    } else if (e.key === "1") {
      e.preventDefault();
      activeViewer.fit(1.0, false);
    }
  }
});
})();`;

const provenanceBadge = (
  row2Content: string,
): string => {
  if (!row2Content) return "";

  return `<div class="provenance" aria-label="Provenance">
  ${row2Content}
</div>`;
};

export type CanvasPageOptions = {
  demoSample?: string;
};

/** No origin: every address on this page is a path, and resolves against the reader's own. */
export const canvasPage = (
  canvas: Canvas,
  nonce: string,
  options?: CanvasPageOptions,
): string => {
  const title = canvas.document?.title ?? canvas.id;
  const summary = canvas.document?.summary;
  const tiles = canvas.drawing.tiles;
  const provenance = canvas.document?.provenance;

  const { mrTitle, row2Content } = resolveProvenanceInfo(
    canvas.id,
    title,
    provenance,
  );

  const demoBanner =
    options?.demoSample === undefined
      ? ""
      : `<div class="demo-banner">
  <div>💡 <strong>Demo mode:</strong> Synthetic architectures based on PR #17.</div>
  <div class="demo-switch" role="tablist" aria-label="Demo architecture samples">
    <a href="/demo?sample=single" class="demo-tab${options.demoSample === "single" ? " active" : ""}">Single Diagram (1)</a>
    <a href="/demo?sample=multi" class="demo-tab${options.demoSample === "multi" ? " active" : ""}">Multi Diagram (6)</a>
  </div>
</div>`;

  const body =
    tiles.length === 0
      ? `<p class="empty">This canvas holds a document but no pictures were drawn from it${
          canvas.document === undefined
            ? ", because this server cannot read its schema version"
            : ""
        }.</p>`
      : tiles.map((tile, idx) => tileFigure(canvas.id, tile, idx)).join("\n");

  const tilesData = tiles.map((tile, idx) => ({
    index: idx,
    id: tile.id,
    title: tile.title,
    lens: tile.lens,
    crumbs: tile.crumbs,
    width: tile.width,
    height: tile.height,
    hero: !!tile.hero,
    files: {
      light: tile.files.light ? imagePath(canvas.id, tile.files.light) : undefined,
      dark: tile.files.dark ? imagePath(canvas.id, tile.files.dark) : undefined,
    },
  }));

  const canvasPayload = {
    canvasId: canvas.id,
    title: mrTitle,
    tiles: tilesData,
  };

  const canvasDataJson = JSON.stringify(canvasPayload).replace(/</g, "\\u003c");
  const tilesJson = JSON.stringify(tilesData).replace(/</g, "\\u003c");

  const viewControls = `<div class="view-controls" id="view-controls">
  <div class="mode-switch" role="radiogroup" aria-label="View mode">
    <button type="button" role="radio" data-mode-choice="document" aria-checked="true" title="Document reading mode">Document</button>
    <button type="button" role="radio" data-mode-choice="canvas" aria-checked="false" title="Interactive canvas mode">Canvas</button>
  </div>
</div>`;

  const canvasWorkspace = canvasWorkspaceHtml(
    canvas.id,
    title,
    provenance,
    tiles,
    canvas.rev,
  );

  const topNavExtra = `${viewControls}
<button type="button" class="btn-help-trigger" id="page-help-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts (?)">?</button>`;

  return shell(
    mrTitle,
    `<main>
${demoBanner}
<h1>${escape(mrTitle)}</h1>
${provenanceBadge(row2Content)}
${summary === undefined ? "" : `<p class="lede">${escape(summary)}</p>`}
<p class="rev">Revision ${canvas.rev} &middot; ${tiles.length} diagram${tiles.length === 1 ? "" : "s"}</p>
${body}
</main>
${canvasWorkspace}
${LIGHTBOX_HTML}
${HELP_DIALOG_HTML}
<script id="pr-lens-data" type="application/json">${canvasDataJson}</script>
<script id="pr-lens-tiles" type="application/json">${tilesJson}</script>
<script nonce="${nonce}">${INTERACTIVE_WIRING}</script>`,
    nonce,
    topNavExtra,
  );
};

/** What the index page says about the server behind it. */
export type Facts = {
  /** "git" or "memory" — which is the difference between kept and forgotten. */
  store: string;
  /** False means every answer carries `tiles: []`. */
  draws: boolean;
  /** How many canvases are held. Undefined when the store could not say. */
  count: { canvases: number; atLeast: boolean } | undefined;
};

/**
 * `GET /`, for the person who pasted the host into a browser to find out what it
 * is.
 *
 * Most of the page is one worked example, because the useful thing to know is not
 * that a canvas server exists but how to make a working setup point at this one:
 * the PR Lens skill and the CLI both default to prlens.dev, and one environment
 * variable is what redirects them here.
 *
 * No canvas id appears, since an id is a read capability. Everything else about
 * the server is fair game.
 */
export const indexPage = (
  origin: string,
  facts: Facts,
  nonce: string,
): string =>
  shell(
    "PR Lens canvas server",
    `<main class="narrow">
<h1>PR Lens canvas server</h1>
<p class="lede">This host keeps <a href="https://github.com/coldteadotai/pr-lens">PR Lens</a>
canvases: a diagram of a change, pushed from your machine, kept as a document and
served back as pictures. It speaks version 1 of the canvas API, so nothing you
push here is sent to prlens.dev.</p>
<p class="demo-lead">👉 <strong><a href="/demo">Try the interactive demo</a></strong> with sample architectures &mdash; no setup or git repository required.</p>

<h3>Send your diagrams here instead of prlens.dev</h3>
<p>The CLI and the PR Lens agent skill both default to prlens.dev. One variable
redirects them at this host &mdash; put it in your shell profile and forget it:</p>
<pre><code>export PR_LENS_API_URL=${escape(origin)}</code></pre>
<p>Or per command, without exporting anything:
<code>--api ${escape(origin)}</code>.</p>

<h3>With the agent skill</h3>
<p>With that variable set, ask for a diagram the way you normally would:</p>
<pre><code>$ claude "diagram this PR with pr-lens"</code></pre>
<p>The skill reads the diff, writes <code>.pr-lens/graph.json</code>, then runs
these three. The last one lands the canvas here:</p>
<pre><code>$ npx @coldtea/pr-lens-cli@latest validate .pr-lens/graph.json
$ npx @coldtea/pr-lens-cli@latest render .pr-lens/graph.json --theme light
$ npx @coldtea/pr-lens-cli@latest canvas push

✓ ${escape(origin)}/c/Qk3vZp9xLm2aRt8yWn4bCg &mdash; rev 1 &middot; 4 diagrams
  unlisted: anyone you share it with can open it, no sign-in needed
  README embed: ${escape(origin)}/c/Qk3vZp9xLm2aRt8yWn4bCg.svg
  remove: pr-lens canvas delete</code></pre>
<p>The skill's own instructions say that link will be
<code>prlens.dev/c/{id}</code>. It will not; it will be this host. A prlens.dev
link means the variable did not reach the CLI.</p>

<h3>Pushing again</h3>
<p>The same canvas, updated in place. The link does not change, so one you have
already shared keeps working:</p>
<pre><code>$ claude "add the retry queue to that diagram"

✓ ${escape(origin)}/c/Qk3vZp9xLm2aRt8yWn4bCg &mdash; rev 2 &middot; 4 diagrams</code></pre>
<p>Notice that the push printed no write token. It is saved in
<code>.pr-lens/canvas.json</code> alongside this host's address, and the CLI keeps
that file out of git. To take over a canvas on another machine, hand it the edit
link instead:</p>
<pre><code>npx @coldtea/pr-lens-cli@latest canvas pull '${escape(origin)}/c/{id}#w={token}'</code></pre>

<h3>Embedding one in a README</h3>
<pre><code>![Architecture after this change](${escape(origin)}/c/{id}.svg)</code></pre>
<p>That is the <code>README embed</code> line above. It serves the top view and
follows the canvas, so the picture updates when you push. Each individual render also has an address of its own containing
its content hash, which never changes and may be cached for ever.</p>

<h3>Links are the permission</h3>
<p class="warn">There are no accounts here. Anyone holding a view link can read
that canvas, and anyone holding the write token can overwrite or delete it. The
token rides in the link's <code>#fragment</code>, which a browser never sends to a
server &mdash; so share view links freely and edit links carefully.</p>

<h3>This server</h3>
<dl>
<dt>Canvas API</dt><dd>version 1</dd>
<dt>Version</dt><dd>${escape(VERSION)}</dd>
<dt>Canvases</dt><dd>${countText(facts.count)}</dd>
<dt>Store</dt><dd>${escape(facts.store)}${facts.store === "memory" ? " &mdash; forgets every canvas when this process restarts" : ""}</dd>
<dt>Diagrams</dt><dd>${facts.draws ? "drawn on push" : "not drawn; every answer reports 0 diagrams"}</dd>
</dl>

<footer>
<a href="https://github.com/thejoeejoee/pr-lens-git-backend">pr-lens-git-backend</a>
&middot; <a href="https://github.com/coldteadotai/pr-lens/blob/main/docs/canvas-api.md">the canvas API</a>
&middot; <a href="/healthz">healthz</a>
</footer>
</main>`,
    nonce,
  );

/**
 * The operator's own page, in the same shell as every other: their Markdown,
 * rendered elsewhere, dropped where the default body would have gone.
 *
 * Which means their page gets the stylesheet, the theme switcher and the reader's
 * remembered choice for free, and they write only the words.
 */
export const markdownPage = (
  title: string,
  body: string,
  nonce: string,
): string => shell(title, `<main class="narrow prose">\n${body}</main>`, nonce);

const countText = (count: Facts["count"]): string => {
  if (count === undefined) return "&mdash;";
  if (count.canvases === 0) return "none yet";
  return `${count.atLeast ? "at least " : ""}${count.canvases.toLocaleString("en-GB")}`;
};
