'use strict';

// The amgi_bridge add-on's HTTP bodies (anki/addon/amgi_bridge/bridge_server.py),
// as the app's server sends and reads them (src/server/anki/bridgeClient.js).
// Leaving: the bridge protocol moves to a binary layout with a version check.

/** A request body. */
function formatBridgeBody(value) {
  return JSON.stringify(value);
}

/** An answer body, or null for an empty one. Throws when it is not JSON. */
function parseBridgeBody(text) {
  return text ? JSON.parse(text) : null;
}

module.exports = { formatBridgeBody, parseBridgeBody };
