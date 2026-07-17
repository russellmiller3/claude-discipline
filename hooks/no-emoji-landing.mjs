#!/usr/bin/env node
/**
 * PreToolUse hook — block emoji writes/edits to LANDING-PAGE / product HTML.
 *
 * Russell's rule: NEVER use emoji on a landing page / product UI; use Lucide icons.
 *
 * EXEMPTION (2026-07-16): experiment-MONITOR dashboards are NOT landing pages — they
 * are internal live-watch pages Russell deliberately designs WITH scan-marker emoji
 * (see docs/exp150-live.html / exp151 / exp152 and the live-watch watch-template.html).
 * Blocking emoji there is a false-positive: Russell explicitly asked for "emoji stuff
 * matching the samples." So a file whose basename ends in `-live.html`, or is
 * `watch-template.html`, is exempt. Every other .html is still a landing/product page
 * and the emoji ban holds.
 *
 * Override (rare, for any other intentional case): env NO_EMOJI_LANDING_OK=1, or the
 * literal token NO_EMOJI_LANDING_OK in the written text.
 *
 * For Write tool — checks tool_input.content. For Edit — checks tool_input.new_string.
 * Emoji detected on a non-exempt page -> deny JSON listing the offenders. Fail-open on
 * any unexpected error (never brick CC).
 *
 * Lucide loader (paste into the page <head> if not already present):
 *   <script src="https://unpkg.com/lucide@latest"></script>
 *   <script>document.addEventListener('DOMContentLoaded', () => lucide.createIcons());</script>
 * Use shape: <i data-lucide="lock"></i>  (any icon name from lucide.dev/icons)
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const ENV_OVERRIDE = 'NO_EMOJI_LANDING_OK';
const ESCAPE_TOKEN = /\bNO_EMOJI_LANDING_OK\b/;

/**
 * An experiment-monitor / live-watch dashboard — emoji are intentional here, so it is
 * EXEMPT from the landing-page emoji ban. Match by basename: `*-live.html` (every
 * experiment monitor, e.g. exp153-3seed-live.html) or the shared `watch-template.html`.
 */
export function isExperimentMonitor(path) {
  const name = basename((path || '').replace(/\\/g, '/')).toLowerCase();
  return /-live\.html$/.test(name) || name === 'watch-template.html';
}

/** De-duplicated, order-preserving list of emoji glyphs in the given HTML. */
export function emojiOffenders(htmlContent) {
  const glyphs = [...(htmlContent || '').matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]);
  const seen = new Set();
  const offenders = [];
  for (const glyph of glyphs) {
    if (!seen.has(glyph)) { seen.add(glyph); offenders.push(glyph); }
  }
  return offenders;
}

/**
 * PURE core. Returns { block, reason? }. Never throws.
 * `path` is the target file, `htmlContent` the content being written/edited.
 */
export function evaluate({ path = '', htmlContent = '', envOk = false } = {}) {
  if (envOk) return { block: false };
  if (!/\.html?$/i.test(path)) return { block: false };          // only HTML
  if (isExperimentMonitor(path)) return { block: false };        // monitors may use emoji
  if (ESCAPE_TOKEN.test(htmlContent || '')) return { block: false }; // explicit override
  const offenders = emojiOffenders(htmlContent);
  if (offenders.length === 0) return { block: false };

  const offenderList = offenders.slice(0, 10).join(' ');
  const more = offenders.length > 10 ? ` (+${offenders.length - 10} more)` : '';
  const reason =
    `Landing-page rule: emoji are not permitted in landing-page / product HTML. ` +
    `Found: ${offenderList}${more}. ` +
    `Use Lucide icons instead — <i data-lucide="ICON_NAME"></i> (browse at lucide.dev/icons). ` +
    `Common swaps: lock (\u{1F512}), shield (\u{1F6E1}️), check (✓), x (✗), ` +
    `zap (⚡), file-text (\u{1F4C4}). ` +
    `(Experiment-monitor pages named *-live.html are EXEMPT — they use emoji by design. ` +
    `Otherwise, if emoji are genuinely intended, add ${ENV_OVERRIDE}.)`;
  return { block: true, reason };
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if (process.env[ENV_OVERRIDE] === '1') process.exit(0);

  const tool = event.tool_name || '';
  if (tool !== 'Write' && tool !== 'Edit') process.exit(0);

  const input = event.tool_input || {};
  const path = input.file_path || '';
  const htmlContent = tool === 'Write' ? (input.content || '') : (input.new_string || '');

  const verdict = evaluate({ path, htmlContent });
  if (!verdict.block) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }));
  process.exit(0);
}

try { main(); } catch { process.exit(0); } // fail open on any unexpected error
