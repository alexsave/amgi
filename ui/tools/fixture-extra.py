# Adds to a fixture collection what the UI's screens need beyond the e2e-ui skill's own fixture: a
# Korean deck with a subdeck, plain Basic notes in it, a deck longer than a page, and two "amgi Listening" notes with real
# clips (a WAV and an MP3, made by ffmpeg) so the deck page shows its audio chips.
#   <python with anki> ui/tools/fixture-extra.py <dir>/collection.anki2
import os
import subprocess
import sys
import tempfile

from anki.collection import Collection

col = Collection(sys.argv[1])
parent = col.decks.id("한국어")
child = col.decks.id("한국어::일상 표현")
basic = col.models.by_name("Basic")
for front, back in [("역이 어디예요?", "Where is the station?"), ("감사합니다", "Thank you")]:
    note = col.new_note(basic)
    note["Front"], note["Back"] = front, back
    col.add_note(note, child)

# A deck longer than a page (20), for the pager.
long_deck = col.decks.id("Long")
for i in range(1, 26):
    note = col.new_note(basic)
    note["Front"], note["Back"] = f"phrase {i:02d}", f"meaning {i:02d}"
    col.add_note(note, long_deck)

amgi = col.models.by_name("amgi Listening")
if amgi is None:
    sys.exit("install amgi first (ui/tools/fixture-install.mjs): no amgi Listening note type")
with tempfile.TemporaryDirectory() as tmp:
    clips = {}
    for name, freq, ext in [("cue-hello", 440, "wav"), ("target-hello", 660, "mp3"), ("cue-thanks", 520, "wav"), ("target-thanks", 780, "wav")]:
        path = os.path.join(tmp, f"{name}.{ext}")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=0.6",
                        "-ar", "24000", "-ac", "1", path], check=True)
        with open(path, "rb") as f:
            clips[name] = col.media.write_data(f"{name}.{ext}", f.read())
    fields = {n: i for i, n in enumerate(f["name"] for f in amgi["flds"])}
    for cue, target, cue_clip, target_clip in [("Hello", "안녕하세요", "cue-hello", "target-hello"),
                                               ("Thank you", "고맙습니다", "cue-thanks", "target-thanks")]:
        note = col.new_note(amgi)
        note.fields[fields["Cue"]] = cue
        note.fields[fields["Target"]] = target
        note.fields[fields["CueAudio"]] = f'<audio src="{clips[cue_clip]}"></audio>'
        note.fields[fields["TargetAudio"]] = f'<audio src="{clips[target_clip]}"></audio>'
        note.fields[fields["Language"]] = "ko"
        col.add_note(note, parent)
# An amgi note made before its clips were: the list says so ("no audio yet"), last in Long.
note = col.new_note(amgi)
note.fields[fields["Cue"]] = "No clip yet"
note.fields[fields["Target"]] = "아직 없어요"
note.fields[fields["Language"]] = "ko"
col.add_note(note, long_deck)
col.close()
print("added the Korean decks and two amgi notes with clips")
