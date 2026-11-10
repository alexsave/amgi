# Sourced by the e2e shell tools (e2e.sh, fixture.sh, drives.sh). Every amgi server, the fake
# Gemini and every Anki Python child they start gets a fresh, empty temp HOME of its own
# (`env "HOME=$(fresh_home)" ...`), so nothing can reach a real Anki profile
# (~/Library/Application Support/Anki2). Incident 18:42: docs/INCIDENT_1842.md.
# The drives themselves keep the real HOME, so the headless Chrome they start finds the login
# keychain and never asks macOS for one; the node drives start their servers and Anki children
# through test/sandbox-home.cjs, which gives each its own temp HOME the same way.
# XDG_DATA_HOME is unset for everything started from here. The temp HOMEs live under one root,
# checked once to be outside the real home and removed on exit (a caller that sets its own EXIT
# trap removes "$sandbox_root" in it).
sandbox_real_home="$(eval echo "~$(id -un)")"
sandbox_root="$(mktemp -d "${TMPDIR:-/tmp}/amgi-sandbox.XXXXXX")"
case "$(cd "$sandbox_root" && pwd -P)/" in
  "$(cd "$sandbox_real_home" && pwd -P)"/*)
    echo "sandbox: TMPDIR ($sandbox_root) is inside the real home; set TMPDIR outside it" >&2
    rm -rf "$sandbox_root"; exit 1 ;;
esac
trap 'rm -rf "$sandbox_root"' EXIT
fresh_home() { mktemp -d "$sandbox_root/home.XXXXXX"; } # a new empty HOME, under the checked root
unset XDG_DATA_HOME
