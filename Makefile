# amgi from the repository root, with make and no Node: the page is C built to WebAssembly on cdom
# (ui/Makefile, through ui/build.sh), the server is C on cbase (server/, make -C server), and starting
# it is cbase's make serve (make -C server serve), which execs the server binary itself.
#
#   make start    the submodules, the page, the server, then the server on 127.0.0.1:3000
#                 (CBASE_LISTEN=host:port, or PORT, to move it; .env.local holds GEMINI_API_KEY)
#   make dev      the same
#   make build    the page and the server (server/build/amgi), not started
#   amgi up       server/build/amgi up: the server in the background, for the command line
#                 (skills/amgi/SKILL.md); amgi down stops it
#   make test     the C checks, then the JavaScript and Python suites (npm test: tests need node)
#   make lint     eslint (needs npm install)
#
# Node is for the tests and the linter alone; nothing here that builds or starts amgi runs it.
.PHONY: start dev build submodules ui server test lint

start dev: build
	$(MAKE) -s -C server serve

build: ui server

submodules:
	server/tools/submodules.sh

ui: submodules
	ui/build.sh

server: submodules
	$(MAKE) -s -j2 -C server build/amgi build/amgi-serve

test:
	npm test

lint:
	npm run lint
