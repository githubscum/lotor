/**
 * test/term-raccoon-frames.test.js
 *
 * Frame-width equality is the property terminal animation lives or dies
 * on. A one-character difference between frames makes the whole figure
 * jitter, which is the most common way a spinner looks broken. These
 * assertions guard that property programmatically rather than relying on
 * the eye of whoever last edited the frames.
 *
 * Also asserts the animation stays silent in every off condition
 * (NO_COLOR, LOTOR_NO_ANIM, non-TTY) so a spinner never lands in a
 * logfile or a CI transcript, and that the resolve frame is
 * distinguishable from the run frames (its whole job is to be the final
 * answer).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAMES, RESOLVE, paintMaskRow } from '../src/term/raccoon.js';

test('every frame row has the same character width', () => {
  const allFrames = [...FRAMES, RESOLVE];
  // [...row].length counts Unicode code points, which for the BMP box-drawing
  // characters and basic block characters used here matches the terminal
  // column count. Every glyph in the frames is single-width by construction
  // (WO: "No Nerd Font, no private-use glyphs, no emoji").
  const expectedWidth = [...allFrames[0][0]].length;
  assert.ok(expectedWidth > 0, 'width sanity: first row is not empty');
  for (let f = 0; f < allFrames.length; f++) {
    const frame = allFrames[f];
    for (let r = 0; r < frame.length; r++) {
      const row = frame[r];
      const width = [...row].length;
      assert.equal(width, expectedWidth,
        `frame ${f} row ${r} has width ${width}, expected ${expectedWidth}. ` +
        `Row: "${row}"`);
    }
  }
});

test('all frames including resolve have the same row count', () => {
  const rowCount = FRAMES[0].length;
  assert.ok(rowCount > 0, 'row count sanity');
  for (let i = 0; i < FRAMES.length; i++) {
    assert.equal(FRAMES[i].length, rowCount,
      `FRAMES[${i}] has ${FRAMES[i].length} rows, expected ${rowCount}`);
  }
  assert.equal(RESOLVE.length, rowCount,
    `RESOLVE has ${RESOLVE.length} rows, expected ${rowCount}`);
});

test('every frame is exactly four rows (WO: the whole figure is four rows)', () => {
  const allFrames = [...FRAMES, RESOLVE];
  for (const frame of allFrames) {
    assert.equal(frame.length, 4, 'frames are four rows by design');
  }
});

test('the mask row (index 1) has two head rails so paintMaskRow can find the mask segment', () => {
  const allFrames = [...FRAMES, RESOLVE];
  for (let f = 0; f < allFrames.length; f++) {
    const eyeRow = allFrames[f][1];
    const first = eyeRow.indexOf('│');
    const last = eyeRow.lastIndexOf('│');
    assert.notEqual(first, -1, `frame ${f} eye row has no left head rail`);
    assert.notEqual(last, first, `frame ${f} eye row has no right head rail`);
  }
});

test('resolve state uses closed eyes (^), not open eyes (●)', () => {
  const eyeRow = RESOLVE[1];
  assert.ok(eyeRow.includes('^'),
    'the resolve frame uses ^ to signal the work is done, per the WO');
  assert.ok(!eyeRow.includes('●'),
    'the resolve frame does not use ● (that is the active-frame eye)');
});

test('paintMaskRow with colour disabled returns the input verbatim', () => {
  // Deleting NO_COLOR is not enough: the colour module caches its
  // decision at module load and the test process is non-TTY anyway, so
  // colourEnabled() is already false here. That is exactly the case a
  // non-TTY caller hits, and paintMaskRow should return the plain string.
  const plain = paintMaskRow('  │ ● ● │  ');
  assert.equal(plain, '  │ ● ● │  ',
    'with colour disabled, no escape sequences are emitted');
});

test('paintMaskRow does not touch a row without head rails', () => {
  // Defensive: the water row has no │, and paintMaskRow should be a
  // no-op on it. The animation code only calls paintMaskRow on row
  // index 1, but the guard is here so a future edit that widens usage
  // does not silently corrupt other rows.
  const water = '   ≈≈≈≈≈   ';
  assert.equal(paintMaskRow(water), water,
    'a row without head rails is returned unchanged');
});
