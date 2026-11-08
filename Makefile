# amgi from the repository root, with make and no Node: the page is C built to WebAssembly
# (ui/build.sh), the server is C on cbase (server/, make -C server), and starting it is the server
# binary itself.
#
#   make start    the submodules, the page, the server, then the server on 127.0.0.1:3000
#                 (CBASE_LISTEN=host:port, or PORT, to move it; .env.local holds GEMINI_API_KEY)
#   make dev      the same
#   make build    the page and the server, not started
#   make test     the C checks, then the JavaScript and Python suites (npm test: tests need node)
#   make lint     eslint (needs npm install)
#
# Node is for the tests and the linter alone; nothing here that builds or starts amgi runs it.
.PHONY: start dev build submodules ui server test lint

start dev: build
	server/tools/start.sh

build: ui server

submodules:
	server/tools/submodules.sh

ui: submodules
	ui/build.sh

server: submodules
	$(MAKE) -s -j2 -C server build/amgi

test:
	npm test

lint:
	npm run lint
