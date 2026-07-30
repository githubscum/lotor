/**
 * src/term/raccoon.js
 *
 * Loader state. The animal that Lotor is named for (Procyon lotor, the
 * washer), doing the thing it is named for, while the chain verifies.
 *
 * Two frames alternate: the paws move, the water alternates between two
 * wave glyphs, the ears and eyes stay put. When the work resolves the
 * animation is REPLACED by a resolve frame (closed eyes, still water)
 * rather than cleared, so the last thing on screen is the answer.
 *
 * WHEN IT DRAWS AND WHEN IT STAYS SILENT
 *   - Only when stderr is a TTY. A logfile or a CI transcript carrying
 *     escape sequences is corruption; a spinner in one is noise pretending
 *     to be craft.
 *   - Never when NO_COLOR is set (published convention).
 *   - Never when LOTOR_NO_ANIM is set (the documented off switch this WO
 *     required: the animation is the one warm element in an otherwise
 *     cold interface, and an off switch is the honest posture for that).
 *   - Only after a 300ms start delay. Work that completes faster than
 *     that is fast enough to need no theatre; a spinner on a fast command
 *     is noise pretending to be craft, said again.
 *
 * WHY STDERR
 *   The animation is progress, not output. Piping stdout to the next
 *   command must not carry the animation, so it lives on stderr. Same
 *   reasoning as every diagnostic in this repo.
 *
 * CURSOR DISCIPLINE
 *   The cursor is hidden while frames draw and restored on exit or SIGINT.
 *   A hidden cursor left behind by an interrupted spinner is a real
 *   infuriating bug; SIGINT is trapped exactly to prevent it.
 *
 * SCOPE
 *   This module writes to stderr and reads process.env / process.stderr.isTTY.
 *   It does not touch chain, gate, keys, or any external process. No
 *   security surface.
 */

import { colourEnabled } from './colour.js';

const CANVAS_RGB = [13, 13, 13];   // near-black canvas colour for eye foreground
const TEAL_RGB = [26, 155, 138];   // ike teal (#1A9B8A), same as the ok state

const FRAME_INTERVAL_MS = 240;     // spinner tempo. Slow enough that a
                                   // reader sees the paws move, fast enough
                                   // not to feel sluggish.
const START_DELAY_MS = 300;        // work under this returns with no frames.

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const MOVE_UP = '\x1b[1A';
const CARRIAGE_RETURN = '\r';

// Reverse-video treatment for the mask (eye) row: teal background, canvas
// foreground. The eye glyphs and the two head-side rails render in canvas
// colour ON a teal band, so the eyes read as dark holes IN the mask, which
// is what a raccoon's bandit mask actually looks like. A darker teal eye on
// a teal band would be a lower-contrast version of the same mistake; the
// eye has to be the canvas colour so it reads as absence.
const MASK_ON = `\x1b[48;2;${TEAL_RGB.join(';')};38;2;${CANVAS_RGB.join(';')}m`;
const MASK_OFF = '\x1b[0m';

// Frame widths are asserted equal by test/term-raccoon-frames.test.js.
// Any change here must preserve column-count equality across every row of
// every frame including the resolve state. A one-character difference
// makes the whole figure jitter, which is the single most common way
// terminal animation looks broken.
const FRAMES = [
  [
    ' ∩╭─────╮∩ ',   // ' ∩╭─────╮∩ '
    '  │ ● ● │  ',                              // '  │ ● ● │  '
    '  ╰─┬─┬─╯  ',               // '  ╰─┬─┬─╯  '
    '   ≈≈≈≈≈   '                          // '   ≈≈≈≈≈   '
  ],
  [
    ' ∩╭─────╮∩ ',   // ' ∩╭─────╮∩ '
    '  │ ● ● │  ',                              // '  │ ● ● │  '  (unchanged: eyes stay)
    '  ╰┬───┬╯  ',               // '  ╰┬───┬╯  '  (paws swap)
    '   ~~~~~   '                                                    // water alternates to ~
  ]
];

const RESOLVE = [
  ' ∩╭─────╮∩ ',       // ' ∩╭─────╮∩ '
  '  │ ^ ^ │  ',                                          // '  │ ^ ^ │  '  (closed eyes)
  '  ╰─┬─┬─╯  ',                 // '  ╰─┬─┬─╯  '
  '   ─────   '                            // '   ─────   '  (still water)
];

/**
 * Apply the mask treatment to the interior of an eye row. The mask is the
 * segment between the two head rails (│) inclusive; the leading and
 * trailing whitespace stays plain so the teal band does not extend past
 * the head silhouette.
 *
 * With colour disabled (NO_COLOR / non-TTY / call from a test process),
 * returns the row unchanged. That keeps the callers on one code path and
 * lets test/term-raccoon-frames.test.js assert widths on the plain form.
 */
function paintMaskRow(row) {
  if (!colourEnabled()) return row;
  const first = row.indexOf('│');
  const last = row.lastIndexOf('│');
  if (first === -1 || last === -1 || last <= first) return row;
  const prefix = row.slice(0, first);
  const mask = row.slice(first, last + 1);
  const suffix = row.slice(last + 1);
  return `${prefix}${MASK_ON}${mask}${MASK_OFF}${suffix}`;
}

/**
 * True when the animation must not draw. Three orthogonal reasons and each
 * is checked; caller does not need to know which fired.
 */
function shouldSkipAnimation() {
  if (process.env.NO_COLOR != null) return true;
  if (process.env.LOTOR_NO_ANIM != null) return true;
  if (!process.stderr || !process.stderr.isTTY) return true;
  return false;
}

function drawFrame(frame) {
  const rendered = frame.map((row, i) => (i === 1 ? paintMaskRow(row) : row));
  process.stderr.write(rendered.join('\n') + '\n');
}

function clearLastFrame(rowCount) {
  // Move up N rows, clear each on the way. The trailing carriage return
  // parks the cursor at column zero so the next draw lands where the
  // previous one did.
  let out = CARRIAGE_RETURN;
  for (let i = 0; i < rowCount; i++) {
    out += MOVE_UP + CLEAR_LINE;
  }
  process.stderr.write(out);
}

/**
 * Start the raccoon loader. Returns a control object with resolve() and
 * stop() methods.
 *
 * resolve(): replaces the running animation with the RESOLVE frame and
 * stops the loop. The resolve frame stays on screen as the final answer.
 *
 * stop(): clears the animation without a resolve state. For the case
 * where a caller has its own final output and wants the spinner gone
 * before it prints.
 *
 * If animation is disabled (see shouldSkipAnimation), start() returns a
 * no-op control that prints one plain status line if given a label,
 * matching the WO's contract that non-TTY / NO_COLOR contexts get a
 * single plain line and nothing more.
 *
 * @param {string} [label]  optional short label printed in the non-TTY
 *                          fallback path only; ignored while animating.
 */
function start(label) {
  if (shouldSkipAnimation()) {
    if (label) process.stderr.write(`${label}...\n`);
    return {
      resolve: () => { if (label) process.stderr.write(`${label} done.\n`); },
      stop: () => {}
    };
  }

  let cancelled = false;
  let started = false;
  let frameIdx = 0;
  const rowCount = FRAMES[0].length;

  const startTimer = setTimeout(() => {
    if (cancelled) return;
    started = true;
    process.stderr.write(CURSOR_HIDE);
    drawFrame(FRAMES[0]);
  }, START_DELAY_MS);

  const tickTimer = setInterval(() => {
    if (!started || cancelled) return;
    clearLastFrame(rowCount);
    frameIdx = (frameIdx + 1) % FRAMES.length;
    drawFrame(FRAMES[frameIdx]);
  }, FRAME_INTERVAL_MS);

  // Restore the cursor on abnormal exit. SIGINT is the usual case (Ctrl-C
  // during a slow verify) and process.on('exit') catches everything else,
  // including uncaught throws that bubble past the caller.
  const restoreCursor = () => {
    cancelled = true;
    clearTimeout(startTimer);
    clearInterval(tickTimer);
    if (started) {
      clearLastFrame(rowCount);
      process.stderr.write(CURSOR_SHOW);
      started = false;
    }
  };
  process.on('SIGINT', restoreCursor);
  process.on('exit', restoreCursor);

  return {
    resolve: () => {
      cancelled = true;
      clearTimeout(startTimer);
      clearInterval(tickTimer);
      // If the animation never actually drew — work returned faster than
      // the 300ms start-delay — do nothing. The WO is explicit that work
      // under the threshold prints its result with no animation at all,
      // and a resolve frame IS an animation. A raccoon "done" face on a
      // fast command is exactly the noise-pretending-to-be-craft the
      // start delay exists to prevent.
      if (!started) return;
      clearLastFrame(rowCount);
      const rendered = RESOLVE.map((row, i) => (i === 1 ? paintMaskRow(row) : row));
      process.stderr.write(rendered.join('\n') + '\n');
      process.stderr.write(CURSOR_SHOW);
      started = false;
    },
    stop: restoreCursor
  };
}

export { start, FRAMES, RESOLVE, paintMaskRow, shouldSkipAnimation };
