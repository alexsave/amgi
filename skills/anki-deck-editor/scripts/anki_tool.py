#!/usr/bin/env python3
"""Read and edit a real Anki collection from the command line, JSON in and out.

Two backends behind one set of subcommands:

  connect  Anki is open. Talks to the AnkiConnect add-on (code 2055492159) on
           http://127.0.0.1:8765, so Anki itself does every write and its UI,
           undo and sync all see the change.
  direct   Anki is closed. Opens collection.anki2 with Anki's own Python
           library (`pip install anki`), so Anki's own Rust backend still does
           every write - ids, usn/mod, card generation, the unicase-collated
           indexes. Never hand-written SQL.

`--backend auto` (the default) uses AnkiConnect when it answers and the file
otherwise. A collection that is locked (Anki open) with no AnkiConnect is
reported as such, never forced.

Every command prints one JSON document on stdout. Errors print
{"error": ..., "kind": ...} and exit non-zero. Run `anki_tool.py -h` or
`anki_tool.py <command> -h` for arguments; SKILL.md has the workflow.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# A directory named `anki` in the current working directory (a checkout of an
# Anki-related repo, say) merges with the pip package into one namespace
# package and can shadow it. Take the cwd off the import path before anything
# imports `anki`, and put this script's own directory on it for tts.py.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [p for p in sys.path if p not in ("", ".", os.getcwd())]
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import media_refs  # noqa: E402

ANKICONNECT_URL = os.environ.get("ANKICONNECT_URL", "http://127.0.0.1:8765")
ANKICONNECT_KEY = os.environ.get("ANKICONNECT_KEY")
# A direct write reuses a backup this recent instead of taking another.
BACKUP_FRESH_SECONDS = 15 * 60


class ToolError(Exception):
    def __init__(self, message: str, kind: str = "error"):
        super().__init__(message)
        self.kind = kind


# --------------------------------------------------------------------------
# Profiles and paths
# --------------------------------------------------------------------------


def default_base_dir() -> Path:
    """Anki's data folder, per https://docs.ankiweb.net/files.html#file-locations."""
    if os.environ.get("ANKI_BASE"):
        return Path(os.environ["ANKI_BASE"]).expanduser()
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Anki2"
    if system == "Windows":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Anki2"
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / "Anki2"


def probe_lock(collection: Path) -> str:
    """'ok' | 'locked' | 'not-found', without going through Anki's library.

    Anki holds collection.anki2 with locking_mode=exclusive and a zero busy
    timeout for as long as the profile is open, so even a read from a second
    process fails at once with "database is locked". A plain sqlite3 read is
    the cheapest way to ask, and it closes before returning so it can never
    be the thing that stops Anki opening the profile.
    """
    if not collection.exists():
        return "not-found"
    try:
        db = sqlite3.connect(str(collection), timeout=0)
        try:
            db.execute("select ver from col").fetchone()
        finally:
            db.close()
        return "ok"
    except sqlite3.OperationalError as error:
        if "locked" in str(error) or "busy" in str(error):
            return "locked"
        raise


def list_profiles(base: Path) -> list[dict]:
    if not base.is_dir():
        return []
    profiles = []
    for child in sorted(base.iterdir()):
        collection = child / "collection.anki2"
        if child.is_dir() and collection.exists():
            profiles.append({"name": child.name, "collection": str(collection), "state": probe_lock(collection)})
    return profiles


def resolve_collection(args) -> Path:
    if args.collection:
        return Path(args.collection).expanduser()
    base = default_base_dir()
    profiles = list_profiles(base)
    if args.profile:
        for p in profiles:
            if p["name"] == args.profile:
                return Path(p["collection"])
        raise ToolError(f'no profile "{args.profile}" under {base}', "not-found")
    if len(profiles) == 1:
        return Path(profiles[0]["collection"])
    if not profiles:
        raise ToolError(f"no Anki profiles under {base}; pass --collection", "not-found")
    names = ", ".join(p["name"] for p in profiles)
    raise ToolError(f"several profiles ({names}); pass --profile", "ambiguous-profile")


# --------------------------------------------------------------------------
# Search-string escaping (shared by both backends)
# --------------------------------------------------------------------------


def strip_style(rendered: str) -> str:
    """A rendered card side without the note type's CSS, which Anki prepends to every side."""
    return re.sub(r"^\s*<style>.*?</style>", "", rendered, count=1, flags=re.DOTALL)


def quote_search(key: str, value: str) -> str:
    """`key:"value"` with Anki's search wildcards taken literally.

    In Anki's search syntax `*` and `_` are wildcards and `\\` escapes; a
    deck called "N5_vocab" searched unescaped also matches "N5-vocab".
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("*", "\\*").replace("_", "\\_")
    return f'"{key}:{escaped}"'


# --------------------------------------------------------------------------
# AnkiConnect backend
# --------------------------------------------------------------------------


def ankiconnect(action: str, **params):
    body = {"action": action, "version": 6, "params": params}
    if ANKICONNECT_KEY:
        body["key"] = ANKICONNECT_KEY
    request = urllib.request.Request(
        ANKICONNECT_URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            reply = json.loads(response.read())
    except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
        raise ToolError(f"AnkiConnect not reachable at {ANKICONNECT_URL}: {error}", "connect-unreachable")
    if not isinstance(reply, dict) or "error" not in reply:
        raise ToolError(f"unexpected AnkiConnect reply: {reply!r}", "connect-protocol")
    if reply["error"] is not None:
        raise ToolError(f"AnkiConnect {action}: {reply['error']}", "connect-error")
    return reply["result"]


def ankiconnect_alive() -> bool:
    try:
        ankiconnect("version")
        return True
    except ToolError:
        return False


class ConnectBackend:
    name = "connect"

    def close(self):
        pass

    def backup(self):
        # Anki is running, so its own rolling backups are running too.
        return None

    def status(self):
        return {"backend": "connect", "url": ANKICONNECT_URL, "ankiconnectVersion": ankiconnect("version")}

    def decks(self, counts: bool):
        result = []
        for name, deck_id in sorted(ankiconnect("deckNamesAndIds").items()):
            entry = {"id": deck_id, "name": name}
            if counts:
                entry["notes"] = len(ankiconnect("findNotes", query=quote_search("deck", name)))
            result.append(entry)
        return result

    def notetypes(self, name):
        names = ankiconnect("modelNamesAndIds")
        result = []
        for model_name, model_id in sorted(names.items()):
            if name and model_name != name:
                continue
            templates = ankiconnect("modelTemplates", modelName=model_name)
            styling = ankiconnect("modelStyling", modelName=model_name)
            result.append(
                {
                    "id": model_id,
                    "name": model_name,
                    "fields": ankiconnect("modelFieldNames", modelName=model_name),
                    "templates": [{"name": t, "front": v["Front"], "back": v["Back"]} for t, v in templates.items()],
                    "css": styling.get("css", ""),
                }
            )
        if name and not result:
            raise ToolError(f'no note type "{name}"', "not-found")
        return result

    def find(self, query, offset, limit):
        ids = sorted(ankiconnect("findNotes", query=query))
        page = ids[offset : offset + limit]
        infos = ankiconnect("notesInfo", notes=page) if page else []
        notes = []
        for info in infos:
            ordered = sorted(info["fields"].items(), key=lambda kv: kv[1]["order"])
            notes.append(
                {
                    "id": info["noteId"],
                    "notetype": info["modelName"],
                    "fields": {k: v["value"] for k, v in ordered},
                    "tags": info["tags"],
                    "cards": info.get("cards", []),
                }
            )
        return {"total": len(ids), "offset": offset, "limit": limit, "notes": notes}

    def cards(self, note_id):
        card_ids = ankiconnect("findCards", query=f"nid:{int(note_id)}")
        return [
            {
                "id": c["cardId"],
                "template": c.get("template"),
                "deck": c["deckName"],
                "question": strip_style(c["question"]),
                "answer": strip_style(c["answer"]),
            }
            for c in ankiconnect("cardsInfo", cards=card_ids)
        ]

    def create_deck(self, name):
        # Deck names match case-insensitively in Anki, so "korean" finds "Korean".
        before = {n.casefold(): (n, i) for n, i in ankiconnect("deckNamesAndIds").items()}
        if name.casefold() in before:
            existing, deck_id = before[name.casefold()]
            return {"id": deck_id, "name": existing, "created": False}
        deck_id = ankiconnect("createDeck", deck=name)
        return {"id": deck_id, "name": name, "created": True}

    def rename_deck(self, old, new):
        raise ToolError(
            "AnkiConnect has no rename action; rename in Anki (Browse > right-click the deck) "
            "or close Anki and rerun with --backend direct",
            "unsupported",
        )

    def _field_names(self, model_name, cache={}):
        if model_name not in cache:
            try:
                cache[model_name] = ankiconnect("modelFieldNames", modelName=model_name)
            except ToolError:
                raise ToolError(f'no note type "{model_name}"', "invalid")
        return cache[model_name]

    def _check_fields(self, model_name, fields):
        # AnkiConnect silently drops a field name it does not recognise; refuse instead.
        names = self._field_names(model_name)
        unknown = set(fields) - set(names)
        if unknown:
            raise ToolError(f"unknown fields {sorted(unknown)}; this note type has {names}", "invalid")

    def add_notes(self, notes, allow_duplicates):
        known_decks = {n.casefold() for n in ankiconnect("deckNames")}
        results = [None] * len(notes)
        actions, slots = [], []
        for i, n in enumerate(notes):
            try:
                self._check_fields(n["notetype"], n["fields"])
            except ToolError as error:
                results[i] = {"ok": False, "kind": error.kind, "error": str(error)}
                continue
            if n["deck"].casefold() not in known_decks:
                ankiconnect("createDeck", deck=n["deck"])
                known_decks.add(n["deck"].casefold())
            note = {
                "deckName": n["deck"],
                "modelName": n["notetype"],
                "fields": n["fields"],
                "tags": n.get("tags", []),
                "options": {"allowDuplicate": allow_duplicates, "duplicateScope": "deck"},
            }
            actions.append({"action": "addNote", "version": 6, "params": {"note": note}})
            slots.append(i)
        # One round trip, and each note's own error in its own slot: `multi`
        # exists in every AnkiConnect version, canAddNotesWithErrorDetail does not.
        for i, reply in zip(slots, ankiconnect("multi", actions=actions) if actions else []):
            if reply.get("error") is None and reply.get("result"):
                results[i] = {"ok": True, "id": reply["result"]}
            else:
                error = str(reply.get("error") or "not added")
                kind = "duplicate" if "duplicate" in error else "invalid"
                results[i] = {"ok": False, "kind": kind, "error": error}
        self._ensure_in_deck(notes, results)
        return results

    def _ensure_in_deck(self, notes, results):
        """Move freshly added cards that landed outside the requested deck.

        Old AnkiConnect builds (the archived GitHub copy) choose the deck by
        setting the note type's legacy `did`, which modern Anki ignores, so
        every note lands in whatever deck was last used - and the call still
        reports success. Checked here instead of trusted.
        """
        added = [(n, r) for n, r in zip(notes, results) if r and r["ok"]]
        if not added:
            return
        infos = {i["noteId"]: i for i in ankiconnect("notesInfo", notes=[r["id"] for _, r in added])}
        all_cards = [c for i in infos.values() for c in i["cards"]]
        deck_of = {c["cardId"]: c["deckName"] for c in ankiconnect("cardsInfo", cards=all_cards)}
        misplaced = {}
        for n, r in added:
            for card in infos[r["id"]]["cards"]:
                if deck_of.get(card, "").casefold() != n["deck"].casefold():
                    misplaced.setdefault(n["deck"], []).append(card)
                    r["movedToDeck"] = True
        for deck, cards in misplaced.items():
            ankiconnect("changeDeck", cards=cards, deck=deck)

    def update_note(self, note_id, fields, tags):
        note = {"id": int(note_id)}
        if fields is not None:
            model = ankiconnect("notesInfo", notes=[int(note_id)])[0]["modelName"]
            self._check_fields(model, fields)
            note["fields"] = fields
        if tags is not None:
            note["tags"] = tags
        ankiconnect("updateNote", note=note)
        return self.find(f"nid:{int(note_id)}", 0, 1)["notes"][0]

    def delete_notes(self, ids):
        ankiconnect("deleteNotes", notes=[int(i) for i in ids])
        return {"deleted": len(ids)}

    def has_media(self, filename):
        return ankiconnect("retrieveMediaFile", filename=filename) is not False

    def store_media(self, filename, data: bytes):
        return ankiconnect("storeMediaFile", filename=filename, data=base64.b64encode(data).decode())

    def check_media(self):
        raise ToolError("media check needs the collection itself: Tools > Check Media in Anki, or close Anki and use --backend direct", "unsupported")

    def create_notetype(self, spec):
        ankiconnect(
            "createModel",
            modelName=spec["name"],
            inOrderFields=spec["fields"],
            css=spec.get("css", ""),
            isCloze=bool(spec.get("cloze")),
            cardTemplates=[{"Name": t["name"], "Front": t["front"], "Back": t["back"]} for t in spec["templates"]],
        )
        return self.notetypes(spec["name"])[0]


# --------------------------------------------------------------------------
# Direct backend (Anki closed)
# --------------------------------------------------------------------------


class DirectBackend:
    name = "direct"

    def __init__(self, collection: Path):
        state = probe_lock(collection)
        if state == "not-found":
            raise ToolError(f"{collection} does not exist", "not-found")
        if state == "locked":
            raise ToolError(
                "the collection is open in Anki (locked). Either close Anki, or install AnkiConnect "
                "(add-on 2055492159) and keep Anki open",
                "locked",
            )
        try:
            from anki.collection import Collection
        except ImportError:
            raise ToolError("Anki's Python library is missing: pip install anki (match your desktop Anki's version)", "missing-anki")
        self.path = collection
        self.col = Collection(str(collection))
        self._backed_up = False

    def close(self):
        # Always close: a handle left open stops Anki itself opening the profile.
        self.col.close()

    def backup(self):
        """A .colpkg in the profile's own backups/ folder, before the first write.

        Anki only runs its rolling backups while it is open, and this backend
        only runs while it is closed, so nothing else is covering this edit.
        A .colpkg there is what File > Switch Profile > Open Backup restores.
        """
        if self._backed_up:
            return None
        folder = self.path.parent / "backups"
        folder.mkdir(exist_ok=True)
        newest = max(folder.glob("*.colpkg"), key=lambda p: p.stat().st_mtime, default=None)
        if newest and time.time() - newest.stat().st_mtime < BACKUP_FRESH_SECONDS:
            # Recent enough. Anki also writes a backup whenever it closes a
            # profile, so an edit made in Anki since then is already covered.
            self._backed_up = True
            return str(newest)
        self.col.create_backup(backup_folder=str(folder), force=True, wait_for_completion=True)
        self._backed_up = True
        newest = max(folder.glob("*.colpkg"), key=lambda p: p.stat().st_mtime, default=None)
        return str(newest) if newest else str(folder)

    def status(self):
        import anki.buildinfo

        return {
            "backend": "direct",
            "collection": str(self.path),
            "schemaVersion": self.col.db.scalar("select ver from col"),
            "ankiLibraryVersion": anki.buildinfo.version,
            "notes": self.col.note_count(),
            "cards": self.col.card_count(),
        }

    def _deck_search(self, name):
        from anki.collection import SearchNode

        return self.col.build_search_string(SearchNode(deck=name))

    def decks(self, counts: bool):
        result = []
        for d in sorted(self.col.decks.all_names_and_ids(), key=lambda d: d.name):
            entry = {"id": d.id, "name": d.name}
            if counts:
                entry["notes"] = len(self.col.find_notes(self._deck_search(d.name)))
            result.append(entry)
        return result

    def notetypes(self, name):
        result = []
        for entry in sorted(self.col.models.all_names_and_ids(), key=lambda m: m.name):
            if name and entry.name != name:
                continue
            m = self.col.models.get(entry.id)
            result.append(
                {
                    "id": m["id"],
                    "name": m["name"],
                    "kind": "cloze" if m["type"] == 1 else "normal",
                    "fields": [f["name"] for f in m["flds"]],
                    "sortField": m["flds"][m["sortf"]]["name"],
                    "templates": [{"name": t["name"], "front": t["qfmt"], "back": t["afmt"]} for t in m["tmpls"]],
                    "css": m["css"],
                }
            )
        if name and not result:
            raise ToolError(f'no note type "{name}"', "not-found")
        return result

    def _note_json(self, note):
        model = note.note_type()
        return {
            "id": note.id,
            "notetype": model["name"],
            "fields": dict(zip(self.col.models.field_names(model), note.fields)),
            "tags": list(note.tags),
            "cards": list(note.card_ids()),
        }

    def find(self, query, offset, limit):
        ids = sorted(self.col.find_notes(query))
        notes = [self._note_json(self.col.get_note(i)) for i in ids[offset : offset + limit]]
        return {"total": len(ids), "offset": offset, "limit": limit, "notes": notes}

    def cards(self, note_id):
        note = self.col.get_note(int(note_id))
        out = []
        for card in note.cards():
            out.append(
                {
                    "id": card.id,
                    "template": card.template()["name"],
                    "deck": self.col.decks.name(card.did),
                    "question": strip_style(card.question()),
                    "answer": strip_style(card.answer()),
                }
            )
        return out

    def create_deck(self, name):
        existing = self.col.decks.id_for_name(name)
        if existing:
            return {"id": existing, "name": self.col.decks.name(existing), "created": False}
        # decks.id() creates missing "::" parents too, and matches names with
        # Anki's real unicase collation (so "Korean" finds "korean").
        deck_id = self.col.decks.id(name, create=True)
        return {"id": deck_id, "name": self.col.decks.name(deck_id), "created": True}

    def rename_deck(self, old, new):
        deck_id = self.col.decks.id_for_name(old)
        if not deck_id:
            raise ToolError(f'no deck "{old}"', "not-found")
        self.col.decks.rename(deck_id, new)
        return {"id": deck_id, "name": self.col.decks.name(deck_id)}

    def add_notes(self, notes, allow_duplicates):
        from anki.notes import NoteFieldsCheckResult

        results = []
        for n in notes:
            try:
                model = self.col.models.by_name(n["notetype"])
                if model is None:
                    raise ToolError(f'no note type "{n["notetype"]}"', "invalid")
                note = self.col.new_note(model)
                _assign_fields(note, self.col.models.field_names(model), n["fields"])
                note.tags = list(n.get("tags", []))
                if note.fields_check() == NoteFieldsCheckResult.EMPTY:
                    raise ToolError("the first field is empty (Anki's own Add dialog refuses this too)", "invalid")
                if not allow_duplicates and _is_duplicate_in_deck(self, note, n["deck"], NoteFieldsCheckResult):
                    results.append({"ok": False, "kind": "duplicate", "error": "first field already in this deck"})
                    continue
                deck_id = self.col.decks.id(n["deck"], create=True)
                self.col.add_note(note, deck_id)
                if not note.card_ids():
                    raise ToolError("note produced no cards (its templates rendered empty)", "invalid")
                results.append({"ok": True, "id": note.id})
            except ToolError as error:
                results.append({"ok": False, "kind": error.kind, "error": str(error)})
            except Exception as error:  # one bad note never aborts the batch
                results.append({"ok": False, "kind": "invalid", "error": str(error)})
        return results

    def update_note(self, note_id, fields, tags):
        note = self.col.get_note(int(note_id))
        if fields is not None:
            names = self.col.models.field_names(note.note_type())
            unknown = set(fields) - set(names)
            if unknown:
                raise ToolError(f"unknown fields {sorted(unknown)}; this note type has {names}", "invalid")
            for k, v in fields.items():
                note[k] = v
        if tags is not None:
            note.tags = list(tags)
        self.col.update_note(note)
        return self._note_json(note)

    def delete_notes(self, ids):
        self.col.remove_notes([int(i) for i in ids])
        return {"deleted": len(ids)}

    def has_media(self, filename):
        return self.col.media.have(filename)

    def store_media(self, filename, data: bytes):
        return self.col.media.write_data(filename, data)

    def check_media(self):
        r = self.col.media.check()
        return {"missing": list(r.missing), "unused": list(r.unused), "report": r.report}

    def create_notetype(self, spec):
        mm = self.col.models
        if mm.by_name(spec["name"]):
            raise ToolError(f'note type "{spec["name"]}" already exists', "exists")
        m = mm.new(spec["name"])
        if spec.get("cloze"):
            m["type"] = 1
        for field in spec["fields"]:
            mm.add_field(m, mm.new_field(field))
        for t in spec["templates"]:
            tmpl = mm.new_template(t["name"])
            tmpl["qfmt"], tmpl["afmt"] = t["front"], t["back"]
            mm.add_template(m, tmpl)
        m["css"] = spec.get("css", m["css"])
        mm.add(m)
        return self.notetypes(spec["name"])[0]


def _assign_fields(note, names, fields):
    unknown = set(fields) - set(names)
    if unknown:
        raise ToolError(f"unknown fields {sorted(unknown)}; this note type has {names}", "invalid")
    for k, v in fields.items():
        note[k] = v


def _is_duplicate_in_deck(backend, note, deck_name, check_result) -> bool:
    """Anki's own duplicate rule (same note type, same first field), scoped to one deck.

    fields_check() looks collection-wide, which would refuse "안녕" in a new
    deck just because another deck already has it; narrow it the way
    AnkiConnect's duplicateScope="deck" does.
    """
    if note.fields_check() != check_result.DUPLICATE:
        return False
    if not backend.col.decks.id_for_name(deck_name):
        return False
    from anki.collection import SearchNode

    first = note.fields[0]
    query = backend.col.build_search_string(
        SearchNode(deck=deck_name), SearchNode(dupe=SearchNode.Dupe(notetype_id=note.mid, first_field=first))
    )
    return bool(backend.col.find_notes(query))


# --------------------------------------------------------------------------
# Backend selection
# --------------------------------------------------------------------------


def open_backend(args):
    choice = args.backend
    if choice in ("auto", "connect") and (choice == "connect" or ankiconnect_alive()):
        if choice == "connect" and not ankiconnect_alive():
            raise ToolError(f"AnkiConnect not reachable at {ANKICONNECT_URL}", "connect-unreachable")
        return ConnectBackend()
    return DirectBackend(resolve_collection(args))


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


def read_json_arg(value):
    """A JSON literal, @path to a file, or - for stdin."""
    if value == "-":
        return json.load(sys.stdin)
    if value.startswith("@"):
        return json.loads(Path(value[1:]).read_text(encoding="utf-8"))
    return json.loads(value)


def cmd_profiles(args, _backend):
    base = default_base_dir()
    return {"baseDir": str(base), "exists": base.is_dir(), "profiles": list_profiles(base), "ankiconnect": ankiconnect_alive()}


def cmd_status(args, backend):
    return backend.status()


def cmd_decks(args, backend):
    return backend.decks(args.counts)


def cmd_notetypes(args, backend):
    return backend.notetypes(args.name)


def cmd_notes(args, backend):
    parts = []
    if args.deck:
        parts.append(quote_search("deck", args.deck))
    if args.query:
        parts.append(f"({args.query})")
    return backend.find(" ".join(parts) or "deck:*", args.offset, args.limit)


def cmd_cards(args, backend):
    return backend.cards(args.note_id)


def cmd_create_deck(args, backend):
    return backend.create_deck(args.name)


def cmd_rename_deck(args, backend):
    return backend.rename_deck(args.old, args.new)


def cmd_add_notes(args, backend):
    notes = read_json_arg(args.notes)
    if isinstance(notes, dict):
        notes = [notes]
    for i, n in enumerate(notes):
        for key in ("deck", "notetype", "fields"):
            if key not in n:
                raise ToolError(f"note {i} is missing {key!r}", "invalid")
        if not isinstance(n["fields"], dict):
            raise ToolError(f"note {i}: fields must be an object of field name -> value", "invalid")
    results = backend.add_notes(notes, args.allow_duplicates)
    return {
        "added": sum(1 for r in results if r["ok"]),
        "skipped": sum(1 for r in results if not r["ok"]),
        "results": results,
    }


def cmd_update_note(args, backend):
    fields = read_json_arg(args.fields) if args.fields else None
    tags = args.tags.split() if args.tags is not None else None
    return backend.update_note(args.note_id, fields, tags)


def cmd_delete_notes(args, backend):
    if not args.yes:
        raise ToolError("deleting notes also deletes their review history; rerun with --yes once the user has confirmed", "needs-confirmation")
    return backend.delete_notes(args.note_ids)


def cmd_add_media(args, backend):
    path = Path(args.file)
    stored = backend.store_media(args.name or path.name, path.read_bytes())
    form = args.form
    return {"filename": stored, "reference": media_refs.render(stored, form) if form else None}


def cmd_check_media(args, backend):
    return backend.check_media()


def cmd_create_notetype(args, backend):
    spec = read_json_arg(args.spec)
    for key in ("name", "fields", "templates"):
        if key not in spec:
            raise ToolError(f"notetype spec is missing {key!r}", "invalid")
    return backend.create_notetype(spec)


def cmd_fill_audio(args, backend):
    """Generate speech for every note whose audio field lacks a clip for its current text."""
    import tts

    query = quote_search("deck", args.deck)
    if args.query:
        query += f" ({args.query})"
    page = backend.find(query, 0, 10**9)
    planned, done, failed, skipped = [], [], [], 0
    for note in page["notes"]:
        fields = note["fields"]
        if args.text_field not in fields or args.audio_field not in fields:
            skipped += 1
            continue
        text = media_refs.speakable_text(fields[args.text_field])
        if not text:
            skipped += 1
            continue
        filename = media_refs.clip_name(text, args.language, args.name_prefix)
        current = fields[args.audio_field]
        wanted = media_refs.render(filename, args.form)
        if wanted in current:
            skipped += 1
            continue
        planned.append((note, text, filename, current))
    if args.limit is not None:
        planned = planned[: args.limit]
    if args.dry_run:
        return {"wouldGenerate": [{"id": n["id"], "text": t, "filename": f} for n, t, f, _ in planned], "skipped": skipped}

    for note, text, filename, current in planned:
        try:
            if not backend.has_media(filename):
                audio = tts.synthesize(text, args.language, verify=not args.no_verify)
                backend.store_media(filename, audio)
            new_value = media_refs.replace_owned(current, filename, args.form, args.name_prefix)
            backend.update_note(note["id"], {args.audio_field: new_value}, None)
            done.append({"id": note["id"], "filename": filename})
        except Exception as error:  # a failed clip is retried on the next run
            failed.append({"id": note["id"], "text": text, "error": str(error)})
    return {"filled": len(done), "failed": failed, "skipped": skipped, "notes": done}


MUTATING = {"create-deck", "rename-deck", "add-notes", "update-note", "delete-notes", "add-media", "create-notetype", "fill-audio"}


def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--backend", choices=["auto", "connect", "direct"], default="auto")
    p.add_argument("--profile", help="Anki profile name (direct backend)")
    p.add_argument("--collection", help="path to collection.anki2 (direct backend; overrides --profile)")
    p.add_argument("--no-backup", action="store_true", help="skip the .colpkg backup before a direct write")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("profiles", help="list profiles, whether each is locked, and whether AnkiConnect answers")
    sub.add_parser("status", help="which backend answered, and collection facts")
    s = sub.add_parser("decks", help="list decks")
    s.add_argument("--counts", action="store_true", help="include note counts (slower)")
    s = sub.add_parser("notetypes", help="note types with fields, templates and CSS")
    s.add_argument("--name")
    s = sub.add_parser("notes", help="find notes (Anki search syntax), paged")
    s.add_argument("--deck", help="deck name; includes subdecks")
    s.add_argument("--query", help='extra Anki search, e.g. "tag:verb" or "Front:*hello*"')
    s.add_argument("--offset", type=int, default=0)
    s.add_argument("--limit", type=int, default=50)
    s = sub.add_parser("cards", help="a note's cards, rendered to question/answer HTML")
    s.add_argument("note_id", type=int)
    s = sub.add_parser("create-deck", help='find-or-create a deck ("Parent::Child" creates parents)')
    s.add_argument("name")
    s = sub.add_parser("rename-deck")
    s.add_argument("old")
    s.add_argument("new")
    s = sub.add_parser("add-notes", help="add notes from JSON: [{deck, notetype, fields:{name:value}, tags:[]}]")
    s.add_argument("notes", help="JSON, @file.json, or - for stdin")
    s.add_argument("--allow-duplicates", action="store_true", help="add even when the first field already exists in that deck")
    s = sub.add_parser("update-note")
    s.add_argument("note_id", type=int)
    s.add_argument("--fields", help='JSON object of only the fields to change, @file, or -')
    s.add_argument("--tags", help="space-separated; replaces all tags")
    s = sub.add_parser("delete-notes", help="delete notes and their cards and review history")
    s.add_argument("note_ids", nargs="+", type=int)
    s.add_argument("--yes", action="store_true")
    s = sub.add_parser("add-media", help="copy a file into the collection's media folder")
    s.add_argument("file")
    s.add_argument("--name", help="filename to store as (default: the file's own)")
    s.add_argument("--form", choices=["sound", "html", "img"], help="also print the field reference to paste")
    sub.add_parser("check-media", help="Anki's own Check Media: missing and unused files (direct only)")
    s = sub.add_parser("create-notetype", help="create a note type from JSON: {name, fields, templates:[{name, front, back}], css, cloze}")
    s.add_argument("spec", help="JSON, @file.json, or -")
    s = sub.add_parser("fill-audio", help="generate TTS into notes missing audio for their current text (needs OPENAI_API_KEY)")
    s.add_argument("--deck", required=True)
    s.add_argument("--query", help="extra search to narrow which notes")
    s.add_argument("--text-field", required=True, help="field to read aloud")
    s.add_argument("--audio-field", required=True, help="field the clip reference goes in")
    s.add_argument("--language", required=True, help="language of the text, e.g. ko, ja, es, zh-CN")
    s.add_argument("--form", choices=["sound", "html"], default="sound", help="[sound:x.mp3] (default) or <audio src>")
    s.add_argument("--name-prefix", default="tts-", help="clip filename prefix; clips with it are treated as this tool's own")
    s.add_argument("--limit", type=int)
    s.add_argument("--no-verify", action="store_true", help="skip the transcribe-and-compare check")
    s.add_argument("--dry-run", action="store_true")
    return p


COMMANDS = {
    "profiles": cmd_profiles,
    "status": cmd_status,
    "decks": cmd_decks,
    "notetypes": cmd_notetypes,
    "notes": cmd_notes,
    "cards": cmd_cards,
    "create-deck": cmd_create_deck,
    "rename-deck": cmd_rename_deck,
    "add-notes": cmd_add_notes,
    "update-note": cmd_update_note,
    "delete-notes": cmd_delete_notes,
    "add-media": cmd_add_media,
    "check-media": cmd_check_media,
    "create-notetype": cmd_create_notetype,
    "fill-audio": cmd_fill_audio,
}


def main(argv=None):
    args = build_parser().parse_args(argv)
    backend = None
    try:
        if args.command != "profiles":
            backend = open_backend(args)
        backup = None
        if backend and args.command in MUTATING and not args.no_backup and not getattr(args, "dry_run", False):
            backup = backend.backup()
        result = COMMANDS[args.command](args, backend)
        if backend:
            result = {"backend": backend.name, "result": result}
            if backup:
                result["backup"] = backup
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ToolError as error:
        print(json.dumps({"error": str(error), "kind": error.kind}, ensure_ascii=False), file=sys.stdout)
        return 1
    finally:
        if backend:
            backend.close()


if __name__ == "__main__":
    sys.exit(main())
