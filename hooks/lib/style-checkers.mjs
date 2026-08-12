/**
 * style-checkers — THE REGISTRY the shared style governor runs.
 *
 * Every style/format rule Russell enforces at Stop time is listed here exactly once, as a
 * pure DETECTOR: `detect(context) -> violation[]`. Nothing in this file writes a block —
 * hooks/lib/style-verdict.mjs merges everything into ONE message per turn.
 *
 * ADDING A NEW STYLE RULE: write the detector next to its own rule, register it here, and
 * it automatically joins the single combined verdict. Do NOT register a new standalone
 * Stop hook that blocks by itself — that is exactly the stacking defect of 2026-07-26,
 * when four hooks blocked one after another and Russell read four rewrites of one reply.
 *
 * `context` = { payload, entries, turnEntries, reply, turnKey }.
 * A `violation` = { kind, measure?, quote?, guidance? }.
 */

import { proseShapeViolations, DEPTH_REQUEST_RE, TEACHING_REQUEST_RE } from './prose-shape.mjs';
import { analyzeTurn, firstUserText, silentWorkViolations } from '../explain-as-you-work.mjs';
import { compassViolations } from '../compass-line-guard.mjs';
import { narrationViolations } from '../narration-cadence-guard.mjs';
import { repeatedAcrossTurnsViolations } from '../repeated-across-turns-guard.mjs';
import { nakedMultiplierViolations } from '../naked-multiplier-guard.mjs';
import { blufViolations } from '../bluf-first-line-guard.mjs';
import { experimentNameViolations } from '../experiment-name-gloss.mjs';
import { resultCompletenessViolations } from '../result-completeness-guard.mjs';
import { replyTokenHygieneViolations } from '../reply-token-hygiene-guard.mjs';
import { negativeDefinitionViolations } from '../negative-definition-guard.mjs';

/**
 * The length / wall-of-text rule — ONE implementation (lib/prose-shape.mjs), fed the two
 * facts it needs about the turn: did code ship (a wider word budget), and did Russell ask
 * for depth (the total-word cap lifts; a wall still must be broken up).
 */
function detectProseShape(context) {
  const { turnEntries = [], reply = '' } = context;
  const { mutatingCount } = analyzeTurn(turnEntries);
  return proseShapeViolations({
    reply,
    shipped: mutatingCount > 0,
    depthAsked: DEPTH_REQUEST_RE.test(firstUserText(turnEntries)),
    // A mechanism question ("why did X break", "explain", "I don't understand")
    // earns Khan-format room -- see prose-shape.mjs's TEACHING_REQUEST_RE header
    // for the 2026-08-11 incident this closes.
    teachingAsked: TEACHING_REQUEST_RE.test(firstUserText(turnEntries)),
  });
}

export const STYLE_CHECKERS = [
  { id: 'prose-shape',   label: 'TOO LONG / WALL OF TEXT', detect: detectProseShape },
  { id: 'silent-work',   label: 'SILENT WORK',             detect: silentWorkViolations },
  { id: 'narration',     label: 'NARRATION',               detect: narrationViolations },
  { id: 'compass-line',  label: 'NORTHSTAR LINE',          detect: compassViolations },
  // Ordering vs length are different failures: a one-paragraph reply passes prose-shape and can
  // still bury the verdict in its last sentence. Only fires when Russell actually asked something.
  { id: 'bluf',          label: 'ANSWER NOT FIRST',        detect: blufViolations },
  { id: 'experiment-name-gloss', label: 'NAME THE EXPERIMENT', detect: experimentNameViolations },
  { id: 'result-completeness', label: 'RESULT TOO THIN', detect: resultCompletenessViolations },
  { id: 'reply-token-hygiene', label: 'HOOK TOKEN SOUP', detect: replyTokenHygieneViolations },
  // Construct, distinct from length (prose-shape) and ordering (bluf): a three-line reply with the
  // answer first can still define everything by what it ISN'T, which costs Russell a subtraction
  // to find the point. Russell 2026-08-11, after saying it three times in one session.
  { id: 'negative-definition', label: 'NEGATIVE DEFINITION', detect: negativeDefinitionViolations },
  // Different AXIS from repeated-draft (which compares drafts inside ONE turn): this compares
  // this reply against the FINAL replies of recent turns. Added 2026-08-11 after four
  // consecutive replies each passed every checker above and still restated the same baseline,
  // analogy, and caveat every time.
  { id: 'repeated-across-turns', label: 'ALREADY SAID THIS', detect: repeatedAcrossTurnsViolations },
  // A multiplier is the most compressed claim in a status report. Added 2026-08-11 after
  // `ratio 1.84x -> 1.77x` shipped with no numerator, denominator, or direction stated.
  { id: 'naked-multiplier', label: 'MULTIPLIER OF WHAT', detect: nakedMultiplierViolations },
];
