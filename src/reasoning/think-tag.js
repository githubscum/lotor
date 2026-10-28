/*
 * src/reasoning/think-tag.js
 *
 * The one shared THINK_TAG definition for src/reach and src/reasoning
 * (KNOWN-LIMITS 79: separate copies can drift and make the two witnesses
 * disagree). The less-than is built with String.fromCharCode(60) because the
 * agent authoring channel is known to drop that character sequence and to
 * mangle backslashes; a forward slash inside a RegExp constructor string is a
 * plain character, so no escape is needed.
 */
export const THINK_TAG = new RegExp(String.fromCharCode(60) + '/?think>', 'i');