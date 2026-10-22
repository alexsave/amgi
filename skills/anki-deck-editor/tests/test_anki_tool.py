"""Tests for the skill's scripts, against a real collection made by Anki's own library.

    python -m unittest discover -s tests -v      # from the skill folder

The media_refs tests need nothing. The collection tests need `pip install anki`
and are skipped without it. OpenAI is replaced by a local fake HTTP server, so
no key or network is needed.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import media_refs  # noqa: E402

try:
    import anki.collection  # noqa: F401

    HAVE_ANKI = True
except ImportError:
    HAVE_ANKI = False


class MediaRefsTests(unittest.TestCase):
    def test_render_forms(self):
        self.assertEqual(media_refs.render("a.mp3", "sound"), "[sound:a.mp3]")
        self.assertEqual(media_refs.render('a"b.mp3', "html"), '<audio src="a&quot;b.mp3"></audio>')
        self.assertEqual(media_refs.render("p.png", "img"), '<img src="p.png">')

    def test_speakable_text_strips_refs_markup_and_furigana(self):
        field = '<b>日本[にほん]</b>&nbsp;語<br>[sound:x.mp3] <audio src="y.mp3"></audio>'
        self.assertEqual(media_refs.speakable_text(field), "日本 語")

    def test_clip_name_is_stable_and_text_sensitive(self):
        a = media_refs.clip_name("안녕", "ko")
        self.assertEqual(a, media_refs.clip_name("안녕", "ko"))
        self.assertNotEqual(a, media_refs.clip_name("안녕!", "ko"))
        self.assertNotEqual(a, media_refs.clip_name("안녕", "ja"))
        self.assertRegex(a, r"^tts-[0-9a-f]{20}\.mp3$")

    def test_replace_owned_keeps_foreign_refs(self):
        old = media_refs.clip_name("old", "ko")
        new = media_refs.clip_name("new", "ko")
        field = f'hi [sound:author.mp3] [sound:{old}] <audio src="{old}"></audio> <img src="p.png">'
        out = media_refs.replace_owned(field, new, "html")
        self.assertIn("[sound:author.mp3]", out)
        self.assertIn('<img src="p.png">', out)
        self.assertNotIn(old, out)
        self.assertEqual(out.count(new), 1)

    def test_normalize_for_comparison(self):
        self.assertEqual(media_refs.normalize_for_comparison("Hello, World!"), media_refs.normalize_for_comparison("hello world"))


class FakeOpenAI(BaseHTTPRequestHandler):
    """Speech returns b"MP3:" + text; a transcription echoes it unless the text contains MUMBLE."""

    calls: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path.endswith("/audio/speech"):
            req = json.loads(body)
            FakeOpenAI.calls.append(("speech", req["voice"], req["input"]))
            out, ctype = ("MP3:" + req["input"]).encode(), "audio/mpeg"
        else:
            msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body)
            parts = {p.get_param("name", header="content-disposition"): p.get_payload(decode=True) for p in msg.iter_parts()}
            text = parts["file"].decode()[4:]
            FakeOpenAI.calls.append(("transcribe", parts["model"].decode()))
            out, ctype = json.dumps({"text": "nope" if "MUMBLE" in text else text + "."}).encode(), "application/json"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@unittest.skipUnless(HAVE_ANKI, "pip install anki to run the collection tests")
class CollectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeOpenAI)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        profile = self.tmp / "Anki2" / "User 1"
        profile.mkdir(parents=True)
        self.collection = profile / "collection.anki2"
        from anki.collection import Collection

        Collection(str(self.collection)).close()
        self.env = {
            "ANKI_BASE": str(self.tmp / "Anki2"),
            "ANKICONNECT_URL": "http://127.0.0.1:1",  # nothing listens: forces the direct backend
            "OPENAI_BASE_URL": f"http://127.0.0.1:{self.server.server_port}/v1",
            "OPENAI_API_KEY": "test",
        }
        self._saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        import importlib

        import anki_tool
        import tts

        importlib.reload(anki_tool)
        importlib.reload(tts)
        self.tool = anki_tool
        FakeOpenAI.calls = []

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp)

    def run_tool(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = self.tool.main(list(argv))
        out = json.loads(buf.getvalue())
        return code, out

    def ok(self, *argv):
        code, out = self.run_tool(*argv)
        self.assertEqual(code, 0, out)
        return out["result"]

    def add(self, *notes, extra=()):
        return self.ok("add-notes", json.dumps(list(notes)), *extra)

    def test_add_find_update_delete(self):
        res = self.add(
            {"deck": "Korean::Greetings_1", "notetype": "Basic", "fields": {"Front": "안녕", "Back": "hi"}, "tags": ["t"]},
            {"deck": "Korean::Greetings_1", "notetype": "Basic", "fields": {"Front": "안녕", "Back": "dup"}},
            {"deck": "Other", "notetype": "Basic", "fields": {"Front": "안녕", "Back": "other deck is fine"}},
            {"deck": "Korean::Greetings_1", "notetype": "Basic", "fields": {"Front": "", "Back": "empty"}},
            {"deck": "Korean::Greetings_1", "notetype": "Basic", "fields": {"Nope": "x"}},
        )
        self.assertEqual([r["ok"] for r in res["results"]], [True, False, True, False, False])
        self.assertEqual(res["results"][1]["kind"], "duplicate")

        decks = {d["name"]: d["notes"] for d in self.ok("decks", "--counts")}
        self.assertEqual(decks["Korean"], 1)  # subdecks count toward the parent
        # "_" is a wildcard in Anki search; the deck filter must take it literally.
        self.assertEqual(self.ok("notes", "--deck", "Korean::Greetings-1")["total"], 0)

        note = self.ok("notes", "--deck", "Korean::Greetings_1")["notes"][0]
        self.assertEqual(note["fields"], {"Front": "안녕", "Back": "hi"})
        updated = self.ok("update-note", str(note["id"]), "--fields", '{"Back": "hello"}', "--tags", "a b")
        self.assertEqual(updated["fields"]["Back"], "hello")
        self.assertEqual(updated["tags"], ["a", "b"])

        code, out = self.run_tool("delete-notes", str(note["id"]))
        self.assertEqual((code, out["kind"]), (1, "needs-confirmation"))
        self.ok("delete-notes", str(note["id"]), "--yes")
        self.assertEqual(self.ok("notes", "--deck", "Korean")["total"], 0)

    def test_writes_back_up_once(self):
        self.ok("create-deck", "A")
        self.ok("create-deck", "B")
        backups = list((self.collection.parent / "backups").glob("*.colpkg"))
        self.assertEqual(len(backups), 1)

    def test_create_deck_is_find_or_create_case_insensitively(self):
        first = self.ok("create-deck", "Korean")
        again = self.ok("create-deck", "korean")
        self.assertTrue(first["created"])
        self.assertEqual((again["id"], again["created"]), (first["id"], False))

    def test_notetype_and_cloze_cards(self):
        self.ok(
            "create-notetype",
            json.dumps({"name": "C", "cloze": True, "fields": ["Text", "Extra"], "templates": [{"name": "Cloze", "front": "{{cloze:Text}}", "back": "{{cloze:Text}}<br>{{Extra}}"}]}),
        )
        self.add({"deck": "D", "notetype": "C", "fields": {"Text": "{{c1::a}} {{c2::b}}"}})
        note = self.ok("notes", "--query", "note:C")["notes"][0]
        self.assertEqual(len(note["cards"]), 2)
        cards = self.ok("cards", str(note["id"]))
        self.assertNotIn("<style>", cards[0]["question"])

    def test_fill_audio_is_idempotent_and_keeps_foreign_refs(self):
        self.add(
            {"deck": "K", "notetype": "Basic", "fields": {"Front": "감사합니다", "Back": "thanks [sound:author.mp3]"}},
            {"deck": "K", "notetype": "Basic", "fields": {"Front": "MUMBLE", "Back": ""}},
        )
        args = ["fill-audio", "--deck", "K", "--text-field", "Front", "--audio-field", "Back", "--language", "ko"]
        first = self.ok(*args)
        self.assertEqual(first["filled"], 1)
        self.assertEqual(len(first["failed"]), 1)  # never transcribed right: left alone, not given a wrong clip
        self.assertEqual(self.ok(*args)["filled"], 0)

        speeches = sum(1 for c in FakeOpenAI.calls if c[0] == "speech")
        converted = self.ok(*args, "--form", "html")
        self.assertEqual(converted["filled"], 1)
        # Converting only rewrites the reference; the one new synthesis is the MUMBLE note's retry.
        self.assertEqual(sum(1 for c in FakeOpenAI.calls if c[0] == "speech"), speeches + 3)

        notes = {n["fields"]["Front"]: n for n in self.ok("notes", "--deck", "K")["notes"]}
        back = notes["감사합니다"]["fields"]["Back"]
        self.assertIn("[sound:author.mp3]", back)
        self.assertRegex(back, r'<audio src="tts-[0-9a-f]{20}\.mp3"></audio>$')
        self.assertEqual(notes["MUMBLE"]["fields"]["Back"], "")
        self.assertEqual(self.ok("check-media")["missing"], ["author.mp3"])

    def test_locked_collection_is_reported_not_forced(self):
        holder = subprocess.Popen(
            [sys.executable, "-I", "-c", "import sys, anki.collection as c; col = c.Collection(sys.argv[1]); print('open', flush=True); sys.stdin.read(); col.close()", str(self.collection)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "open")
            code, out = self.run_tool("decks")
            self.assertEqual((code, out["kind"]), (1, "locked"))
        finally:
            holder.stdin.close()
            holder.wait()
            holder.stdout.close()
        self.ok("decks")

    def test_integrity_after_edits(self):
        self.add({"deck": "X::Y", "notetype": "Basic", "fields": {"Front": "a", "Back": "b"}})
        self.ok("rename-deck", "X::Y", "X::Z")
        from anki.collection import Collection

        col = Collection(str(self.collection))
        try:
            _, ok = col.fix_integrity()
            self.assertTrue(ok)
            self.assertIsNotNone(col.decks.id_for_name("X::Z"))
        finally:
            col.close()


if __name__ == "__main__":
    unittest.main()
