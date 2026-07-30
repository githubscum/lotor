/**
 * src/term/colour.js
 *
 * Colour convention for Lotor's terminal surface. Locked 2026-07-23 for the
 * website and applied here.
 *
 *   gate   #C41E3A   ike red      stops and waits for a signature
 *   warn   #D4A017   ike gold     runs, and is written to the record
 *   ok     #1A9B8A   ike teal     verified, intact, done
 *   off    #6B7280   muted grey   rule disabled, not watching
 *
 * Every state that is coloured also says its name in words. Colour is
 * ornament on meaning, never the carrier. A colour-blind reader and a
 * logfile reader must lose nothing.
 *
 * Escapes are 24-bit ANSI (\x1b[38;2;R;G;Bm). Windows Terminal, iTerm,
 * modern gnome-terminal, and every VS Code integrated terminal support it.
 * There is no 16-colour fallback: approximating these hues to xterm-256 or
 * the base ANSI palette produces a different reading (the teal reads
 * greyish, the red reads pink) and the point of the convention is that a
 * reader learns one colour = one meaning.
 *
 * TTY / NO_COLOR discipline:
 *   - If `NO_COLOR` is set to any value, all colour functions return the
 *     plain string. Published convention (no-color.org); ignoring it is rude.
 *   - If stdout is not a TTY, all colour functions return the plain string.
 *     A logfile carrying escape sequences is corruption.
 *   - The check is done once at module load time and cached, so per-frame
 *     spinner loops do not pay the isTTY cost on every write.
 *
 * ADDITIVE ONLY. This module reads env and stdout. It does not write, does
 * not spawn, does not touch chain or gate. No self-mod exposure.
 */

const RGB = {
  gate: [196, 30, 58],   // #C41E3A ike red
  warn: [212, 160, 23],  // #D4A017 ike gold
  ok:   [26, 155, 138],  // #1A9B8A ike teal
  off:  [107, 114, 128], // #6B7280 muted grey
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const COLOUR_ENABLED = (() => {
  if (process.env.NO_COLOR != null) return false;
  if (!process.stdout || !process.stdout.isTTY) return false;
  return true;
})();

function fg(state) {
  if (!COLOUR_ENABLED) return '';
  const rgb = RGB[state];
  if (!rgb) return '';
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function bg(state) {
  if (!COLOUR_ENABLED) return '';
  const rgb = RGB[state];
  if (!rgb) return '';
  return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function colour(state, text) {
  const on = fg(state);
  if (on === '') return text;
  return `${on}${text}${RESET}`;
}

function dim(text) {
  if (!COLOUR_ENABLED) return text;
  return `${DIM}${text}${RESET}`;
}

/**
 * True when the current stream will produce escape sequences. Exposed so
 * a caller doing conditional layout (an animation, a decorative rail) can
 * cheaply skip work rather than emit invisible strings.
 */
function colourEnabled() {
  return COLOUR_ENABLED;
}

export { fg, bg, colour, dim, colourEnabled, RGB };
