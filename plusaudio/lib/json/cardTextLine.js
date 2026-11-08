'use strict';

// The one line plusaudio/generate-card-text.js prints on stdout for the app's
// server (src/server/anki/cardText.js): the card's text fields. Leaving: a
// fixed layout can replace it; until then both ends meet here.

/** The line a generated card is printed as, newline included. */
function formatCardTextLine(card) {
  return `${JSON.stringify(card)}\n`;
}

/** The card a generator run printed. Throws when stdout is not one. */
function parseCardTextLine(stdout) {
  return JSON.parse(stdout.trim());
}

module.exports = { formatCardTextLine, parseCardTextLine };
