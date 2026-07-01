#!/usr/bin/env node
/**
 * Stop hook — on an EXPLAINING turn (no code written this turn), block if the reply uses
 * jargon without glossing it nearby.
 *
 * Russell's rule (2026-07-01, Marcus project): "each technical term should be glossed in a
 * few plain words, coffee-shop level." Twice in one session I dropped ungloss ed jargon (BCE,
 * fine-tuning) into an otherwise-plain explanation and had to redo it at Khan-Academy level
 * after Russell asked. A system-prompt instruction alone didn't stop the repeat — this hook
 * enforces the OUTCOME: the first use of a jargon term in a reply must have a gloss nearby.
 *
 * Scope: fires on EXPLAINING turns always. On a turn that ALSO wrote code, it fires only when
 * the final message is a SUBSTANTIAL explanation (>= 40 words), not a terse status beat — because
 * a whole page of jargon slipped through once JUST because the same turn also edited a file. The
 * old "skip every code turn" rule WAS the bug (2026-07-01, Russell: "pages of jargon i didnt
 * follow, need to follow hook no jargon. fix hook"). Only checks the FIRST occurrence of each term
 * per reply — once glossed, later mentions are fine. Skips any term the "Already known ... :"
 * reminder line lists (dynamically read from the transcript, e.g. "embedding").
 */
import { readFileSync, existsSync } from 'node:fs';

const CODE_EXTENSIONS = /\.(go|rs|js|ts|jsx|tsx|py|rb|java|kt|swift|c|cpp|h|cs|ex|exs|ml|hs|clj|scala|lua|php|sh|bash|mjs|cjs)$/i;
const DOC_PATHS = /\.(md|txt|json|toml|yaml|yml|html?|css|svg)$/i;

function isCodeFile(path) {
  if (!path) return false;
  const normalizedPath = path.replace(/\\/g, '/');
  if (DOC_PATHS.test(normalizedPath)) return false;
  return CODE_EXTENSIONS.test(normalizedPath);
}

// Terms worth glossing when they appear UNEXPLAINED. Extend as new repeat-offenders surface.
// Multi-word terms are matched literally; put the more-specific one first (e.g. 'gradient descent'
// before 'gradient') so it's the one reported.
const JARGON_TERMS = [
  // training / neural nets
  'BCE', 'SGD', 'RLHF', 'RLVR', 'GRPO', 'PPO', 'SFT', 'GNN', 'MLP', 'LoRA', 'MiniLM', 'BERT',
  'backpropagation', 'backprop', 'fine-tuning', 'fine-tune', 'pretraining', 'pretrained',
  'tokenizer', 'tokenization', 'logits', 'logit', 'softmax', 'sigmoid', 'hyperparameter',
  'checkpoint', 'epoch', 'cross-entropy', 'quantization', 'distillation', 'embedding',
  'policy gradient', 'reward model', 'latent space', 'activation function',
  'encoder', 'decoder', 'transformer', 'proposer', 'readout', 'forward pass', 'end-to-end',
  'gradient descent', 'gradient', 'stochastic', 'inference', 'overfit', 'overfitting',
  'generalize', 'generalizes', 'generalization', 'plateau', 'ablation',
  'parameter group', 'param group', 'warmup', 'learning rate', 'discriminative',
  'marginals', 'marginal', 'argmax', 'differentiable', 'relaxation', 'seed quality',
  // logic / solver
  'soft-Z3', 'soft Z3', 'soft-sat', 'soft satisfaction', 'soft checker', 'combinatorial',
  'satisfiability', 'CNF', 'SMT', 'formalization', 'formalizer', 'clause',
];

// A gloss marker: a parenthetical, an explanatory dash/colon, or a plain-English signal phrase.
const GLOSS_MARKERS = [
  /\([^)]{8,}\)/,                                    // a real parenthetical (not just "(RL)")
  /\s[-–—]\s+[a-z]/,                                 // " - a way of..." / " — nudging weights..."
  /:\s+[a-z]/,                                       // "fine-tuning: adjusting weights..."
  /\b(which means|meaning|in other words|think of it like|basically|plain english|i\.e\.|that is,|a way (of|to)|a method for|a technique for)\b/i,
];

function extractAlreadyKnownTerms(transcriptText) {
  const match = transcriptText.match(/Already known[^:]*:\s*([^\n<"]+)/i);
  if (!match) return new Set();
  return new Set(
    match[1].split(',').map((term) => term.trim().replace(/[^a-z0-9\s-]+$/i, '').toLowerCase()).filter(Boolean)
  );
}

function sentencesOf(replyText) {
  return replyText.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
}

function findUnglossedTerm(replyText, alreadyKnownTerms) {
  const sentences = sentencesOf(replyText);
  for (const term of JARGON_TERMS) {
    if (alreadyKnownTerms.has(term.toLowerCase())) continue;
    const termPattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const sentenceIndex = sentences.findIndex((sentence) => termPattern.test(sentence));
    if (sentenceIndex === -1) continue; // term not used this reply

    const nearbyText = sentences.slice(sentenceIndex, sentenceIndex + 2).join(' ');
    const isGlossed = GLOSS_MARKERS.some((marker) => marker.test(nearbyText));
    if (!isGlossed) return term;
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  if (event.stop_hook_active) process.exit(0); // avoid infinite loops

  const transcriptPath = event.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

  let transcriptText = '';
  try {
    transcriptText = readFileSync(transcriptPath, 'utf8');
  } catch {
    process.exit(0);
  }
  if (!transcriptText) process.exit(0);
  if (process.env.JARGON_GLOSS_OVERRIDE === '1') process.exit(0);

  const lines = transcriptText.split('\n').filter(Boolean);
  let lastAssistantText = '';
  let codeWasWritten = false;
  let inCurrentTurn = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const role = entry.message?.role || entry.role;
    const content = entry.message?.content || entry.content || [];

    if (role === 'assistant' && !lastAssistantText) {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') lastAssistantText += block.text + '\n';
          if (block?.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
            if (isCodeFile(block.input?.file_path || '')) codeWasWritten = true;
          }
        }
      } else if (typeof content === 'string') {
        lastAssistantText = content;
      }
      inCurrentTurn = true;
      continue;
    }

    if (inCurrentTurn) {
      if (role === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
            if (isCodeFile(block.input?.file_path || '')) codeWasWritten = true;
          }
        }
      }
      if (role === 'user') break;
    }
  }

  if (!lastAssistantText.trim()) process.exit(0);
  // The gloss rule is ALWAYS on (Russell's output style). But a terse coding status beat
  // ("wired the loss into the loop") isn't where jargon-walls happen — a long EXPLANATION is.
  // So on a turn that also wrote code, only check when the final message is substantial. A
  // pure explaining turn (no code) is always checked, at any length.
  const CODE_TURN_EXPLANATION_MIN_WORDS = 40;
  const wordCount = lastAssistantText.trim().split(/\s+/).filter(Boolean).length;
  if (codeWasWritten && wordCount < CODE_TURN_EXPLANATION_MIN_WORDS) process.exit(0);
  if (/jargon-gloss override:/i.test(lastAssistantText)) process.exit(0);

  const alreadyKnownTerms = extractAlreadyKnownTerms(transcriptText);
  const unglossedTerm = findUnglossedTerm(lastAssistantText, alreadyKnownTerms);
  if (!unglossedTerm) process.exit(0);

  const reason =
    `STOP — jargon used without a gloss (Russell, 2026-07-01: "gloss technical terms, coffee-shop level").\n\n` +
    `"${unglossedTerm}" appears in your reply with no plain-English explanation nearby.\n\n` +
    `Add a few plain words next to its first use — a parenthetical or a short dash-explanation is enough:\n` +
    `  "${unglossedTerm} (a few plain words for what it does)"\n\n` +
    `If it's truly already understood this session and not in the "already known" list, ` +
    `write "jargon-gloss override: <why>" and the stop will pass.`;

  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
