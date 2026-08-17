#!/usr/bin/env node
/**
 * found-it-fix-it-guard — you noticed it, so it is yours. No buck-passing.
 *
 * new-hook-category: Meta (hook discipline) — nearest existing hook is
 * `ross-perot-guard` (blocks ASKING instead of acting). This is the sibling
 * failure it does not cover: not asking permission, but DISOWNING. The reply
 * names a real defect, declares it somebody else's problem or somebody else's
 * turn, and stops. Ross Perot fires on "should I?"; this fires on "not mine."
 * Different sentence, different fix, same event — kept separate because
 * merging them would need one regex to mean two opposite things.
 *
 * Russell, 2026-08-17, verbatim: "No. Never. If you see something, it's your
 * problem, and you're going to fucking fix it, not pass the buck." Said after I
 * found the branch-sprawl blocker was tested but never installed — dead code
 * that had never once fired — and wrote "but it's a separate concern from what
 * I'm working on."
 *
 * WHY A FOUND-AND-UNFIXED BUG IS WORSE THAN AN UNFOUND ONE: it is now
 * known-broken and still shipping, and the next person to see it reads the note
 * saying it is fine and moves on too.
 *
 * The bar for firing is deliberately high: the reply must BOTH name a real
 * defect AND disown it. Naming a defect while fixing it is the behaviour we
 * want, so "I found X, fixed it" must never fire.
 */
import { readFileSync } from 'node:fs';

// Disowning language. Each must be a claim about WHOSE problem it is, not a
// neutral description, or ordinary engineering talk starts tripping it.
const DISOWNING = [
  // ANY subject, not just it/that/this: "The failing suite is a separate issue"
  // is the same buck-pass and the first two versions of this pattern missed it.
  // Broadening is safe because a DEFECT word is required below — that is what
  // keeps "caching is a separate concern from parsing" out of scope, not a
  // narrow subject list. Both its own tests caught these in turn.
  /\bis\s+(?:a\s+)?separate\s+(?:concern|issue|problem|matter|change|pr\b)/i,
  /\bseparate\s+concern\s+from\s+what\s+I'?m\s+(?:working|doing)/i,
  /\b(?:out of|outside)\s+scope\s+for\s+(?:this|now|the current)/i,
  /\bnot\s+(?:caused\s+by|introduced\s+by|related\s+to)\s+(?:my|this)\s+(?:change|edit|work|fix)\b/i,
  /\bpre-?existing[^.!?]{0,40}\bnot\s+(?:mine|ours|my\s+problem)\b/i,
  /\bI'?ll\s+(?:just\s+)?(?:note|flag|record|log)\s+(?:it|this|that)\s+(?:for|and)\s+(?:later|now|move)/i,
  /\bleav(?:e|ing)\s+(?:it|that)\s+(?:for|to)\s+(?:another|a\s+future|the\s+next)\s+(?:session|turn|pass|pr)\b/i,
  /\bnot\s+(?:going\s+to|gonna)\s+(?:chase|fix)\s+(?:it|that)\s+(?:here|now)\b/i,
];

// A defect actually exists to be disowned. Without this, a reply that merely
// uses the phrase about a TOPIC ("caching is a separate concern from parsing")
// would fire, which is ordinary design talk and none of this hook's business.
const DEFECT = [
  /\b(?:fail(?:s|ed|ing|ure)?|red|broken|breaks|bug|defect|regression|crash(?:es|ed|ing)?)\b/i,
  /\b(?:dead code|never (?:fires|ran|installed|registered)|not (?:installed|registered|wired))\b/i,
  /\b(?:stale|wrong|incorrect|mismatch(?:ed)?|leak(?:s|ing|ed)?)\b/i,
];

// Evidence the defect is being HANDLED in this same turn. Any of these and the
// hook stays quiet: naming a problem you are fixing is exactly right.
// RED-TEAMED 2026-08-17, and this list started wider. It used to accept a bare
// "landed / shipped / committed / merged", which is the commonest escape there
// is: almost every working reply says one of those about SOMETHING, so
// "Committed the docs. That failure is a separate issue." sailed straight
// through. Evidence of handling must be evidence of handling THE DEFECT — a
// repair verb or a green count — not proof that unrelated work got committed.
const HANDLED = [
  /\b(?:fixed|fixing|repaired|repairing|corrected|correcting|patched|patching)\b/i,
  /\bnow\s+(?:green|passes|passing|registered|installed|wired|fires)\b/i,
  /\b\d+\s*\/\s*\d+\s+(?:green|passing)\b/i,
  /\b\d+\s+passed,\s*0\s+failed\b/i,
];

// The three deferrals Russell actually allows, each of which must be NAMED.
const LEGITIMATE = [
  /\b(?:destructive|irreversible|data\s*loss|cannot\s+be\s+undone)\b/i,
  /\b(?:needs?|requires?|awaiting)\s+(?:Russell|your)\s+(?:decision|call|approval|say)/i,
  /\$\s*\d/,
];

export function findBuckPassing(replyText) {
  const reply = String(replyText || '');
  if (!reply.trim()) return null;
  const disowning = DISOWNING.find((pattern) => pattern.test(reply));
  if (!disowning) return null;
  if (!DEFECT.some((pattern) => pattern.test(reply))) return null;
  if (HANDLED.some((pattern) => pattern.test(reply))) return null;
  if (LEGITIMATE.some((pattern) => pattern.test(reply))) return null;
  return reply.match(disowning)?.[0] || 'disowning language';
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if (process.env.FOUND_IT_FIX_IT_OFF === '1') process.exit(0);

  const quote = findBuckPassing(event.final_reply_text || event.finalReplyText || '');
  if (!quote) process.exit(0);

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      `YOU FOUND IT, SO IT IS YOURS — buck-passing detected: "${quote}"\n\n` +
      'Russell, 2026-08-17: "No. Never. If you see something, it\'s your problem, ' +
      'and you\'re going to fucking fix it, not pass the buck."\n\n' +
      'You named a real defect and declared it not yours. Pre-existing is not a ' +
      'defence — it means it has been broken longer. A found bug nobody fixes is ' +
      'worse than an unfound one: it is now known-broken and still shipping.\n\n' +
      'FIX IT THIS TURN. The only deferrals that count, and each must be named ' +
      'explicitly: it is genuinely destructive or irreversible, it needs Russell\'s ' +
      'decision, or it exceeds the standing $5 budget.',
  }));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('found-it-fix-it-guard.mjs')) main();
