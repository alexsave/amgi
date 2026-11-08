# Third-party notices

amgi is licensed under the GNU Affero General Public License, version 3 or later (see `LICENSE`).
The parts below come from elsewhere and keep their own licences; the last section notes two of amgi's own assets that are not code.
Node packages installed by `npm install` are not listed here; each carries its own licence in `node_modules`.

## cdom

The C DOM library the page is built on, included as a git submodule at `cdom/` (https://github.com/alexsave/cdom).
Copyright (c) 2026 Alex Saveliev.
Licensed under the MIT License; the full text is the LICENSE file in its repository (https://github.com/alexsave/cdom/blob/main/LICENSE).

## cbase

The C backend platform the server is built on, included as a git submodule at `cbase/` (https://github.com/alexsave/cbase), pinned to its tag v0.1.2.
Copyright (c) 2026 Alex Saveliev.
Licensed under the MIT License; the full text is the LICENSE file at the root of its repository (https://github.com/alexsave/cbase/blob/main/LICENSE).

## Libraries the server links

`server/build/amgi` links these system libraries, installed by Homebrew on macOS (they are not in this repository):

- **SQLite** (https://sqlite.org), in the public domain (https://sqlite.org/copyright.html).
- **ICU** 78 (https://icu.unicode.org), under the Unicode License v3 (https://www.unicode.org/license.txt).
- **OpenSSL** 3 (https://www.openssl.org), under the Apache License 2.0 (https://www.openssl.org/source/license.html).

## Heroicons

The outline icon paths in `ui/src/dom.c` (`ICON_COG`, `ICON_COG_HUB`, `ICON_PLUS`, `ICON_TRASH`, `ICON_X`) are copied from Heroicons (https://github.com/tailwindlabs/heroicons), 24 px outline set.
Its licence, from https://github.com/tailwindlabs/heroicons/blob/master/LICENSE:

```
MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Anki

`plusaudio/vendor/anki-src/` holds files copied unchanged from Anki (https://github.com/ankitects/anki) at tag 26.09.2, commit bb0dd6d1310afe290dea5e5a440400f851789936, each with a header naming its upstream path.
Their own headers, where they carry one, are kept: "Copyright: Ankitects Pty Ltd and contributors" and "License: GNU AGPL, version 3 or later".
A few short fragments of Anki's source are reproduced in `server/collection/notes.c` with a comment naming where they come from (the id allocation expression of `add.sql`, the base-91 alphabet of `rslib/src/notes/mod.rs`), under the same licence.
Anki's licence statement, from https://github.com/ankitects/anki/blob/bb0dd6d1310afe290dea5e5a440400f851789936/LICENSE:

```
Anki is licensed under the GNU Affero General Public License, version 3 or
later, with portions contributed by Anki users licensed under the BSD-3
license (see CONTRIBUTORS).

The following included source code items use a license other than AGPL3:

In the pylib folder:

 * statsbg.py: CC BY 4.0.

In the qt folder:

 * Anki's translations are a mix of BSD and public domain.
 * mpv.py: MIT.
 * winpaths.py: MIT.
 * MathJax: Apache 2.
 * jQuery and jQuery-UI: MIT.
 * plot.js: MIT.
 * protobuf.js: BSD 3 clause

The above list only covers the source code that is vendored in this
repository. Binary distributions also include copies of Qt translation
files (LGPL), and all of the Python, Rust and Javascript libraries
that this code references.

Anki's logo is copyright Alex Fraser, and is licensed under the AGPL3 like the
rest of Anki's code.

The logo is also available under a limited alternative license for inclusion
in books, blogs, videos and so on. If the following conditions are met, you
may use the logo in your work without the need to license your work under an
AGPL3-compatible license:

 * The logo must be used to refer to Anki, AnkiWeb, AnkiMobile or AnkiDroid,
   and a link to https://apps.ankiweb.net must be provided. When your
   content is focused specifically on AnkiDroid, a link to
   https://play.google.com/store/apps/details?id=com.ichi2.anki&hl=en
   may be provided instead of the first link.
 * The work must make it clear that the text/video/etc you
   are publishing is your own content and not something originating
   from the Anki project.
 * The logo must be used unmodified - no cropping, changing of colours
   or adding or deleting content is allowed. You may resize the image
   provided the horizontal and vertical dimensions are resized
   equally.

Documentation in the docs-site folder is licensed under the CC BY-SA 4.0
license; other files in that folder remain under the AGPL3.
```

## amgi's own assets

### The favicons

The favicons in `public/` (`favicon.svg`, `favicon.ico`, `favicon-96x96.png`, `apple-touch-icon.png`) are the owner's own work and ship under the repository's licence, AGPL-3.0-or-later.
They show "암기" set in Noto Serif KR; `favicon.svg` names the font and does not embed it.
Noto Serif KR is under the SIL Open Font License 1.1, which does not restrict images rendered with it.

### The starter deck's clips

The clips in `anki/starter/media/` were generated with Gemini text-to-speech, and ship under the repository's licence.
How they were made, and what their reuse is subject to, is in `anki/starter/NOTICE.md`.
