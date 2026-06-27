import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playwrightOffense, inJarvisProject } from './chrome-only-testing-guard.mjs';

test('blocks installing Playwright via every package manager', () => {
  assert.equal(playwrightOffense('npm i playwright'), 'installs Playwright');
  assert.equal(playwrightOffense('npm install playwright @types/node'), 'installs Playwright');
  assert.equal(playwrightOffense('pnpm add playwright'), 'installs Playwright');
  assert.equal(playwrightOffense('yarn add @playwright/test'), 'installs Playwright');
  assert.equal(playwrightOffense('bun install playwright-core'), 'installs Playwright');
});

test('blocks invoking the Playwright CLI', () => {
  assert.equal(playwrightOffense('npx playwright install chromium'), 'invokes the Playwright CLI');
  assert.equal(playwrightOffense('npx playwright test'), 'invokes the Playwright CLI');
  assert.equal(playwrightOffense('playwright install'), 'invokes the Playwright CLI');
  assert.equal(playwrightOffense('cd extension && playwright test'), 'invokes the Playwright CLI');
});

test('passes legitimate, non-Playwright commands', () => {
  assert.equal(playwrightOffense('npm test'), null);
  assert.equal(playwrightOffense('npm run build'), null);
  assert.equal(playwrightOffense('node --env-file=../.env bench/realworld/harness.mjs --task=email-to-calendar --concurrency=4'), null);
  assert.equal(playwrightOffense('node test/live/realExperience.mjs'), null);
  assert.equal(playwrightOffense('git status'), null);
});

test('the override lets a deliberate command through', () => {
  assert.equal(playwrightOffense('npm i playwright   # chrome-only-override: one-off upstream repro, not jarvis testing'), null);
});

test('scopes to the Jarvis project only (gated on the working directory)', () => {
  assert.equal(inJarvisProject('C:/Users/rmill/Desktop/programming/jarvis/extension'), true);
  assert.equal(inJarvisProject('C:\\Users\\rmill\\Desktop\\programming\\jarvis'), true); // windows backslashes
  assert.equal(inJarvisProject('/home/x/jarvis'), true);
  assert.equal(inJarvisProject('C:/other/project'), false); // a real other project — leave it alone
  assert.equal(inJarvisProject('C:/work/jarvis-clone/extension'), false); // similar name, not the jarvis project
});
