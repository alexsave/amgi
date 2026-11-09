# Sourced by the e2e shell tools (e2e.sh, fixture.sh, drives.sh): every process they start runs with
# a fresh, empty temp HOME and no XDG_DATA_HOME, so nothing can reach a real Anki profile
# (~/Library/Application Support/Anki2). Incident 18:42: ~/Dev/foolish-reports/incident-1842.md.
# The shell's own HOME becomes one such dir on sourcing; `fresh_home` makes another for one child.
# The root is checked once to be outside the real home, so every HOME under it is too.
# All of them live under one temp root, removed on exit (a caller that sets its own EXIT trap
# removes "$sandbox_root" in it). The node half is test/sandbox-home.cjs.
sandbox_real_home="$(eval echo "~$(id -un)")"
sandbox_root="$(mktemp -d "${TMPDIR:-/tmp}/amgi-sandbox.XXXXXX")"
case "$(cd "$sandbox_root" && pwd -P)/" in
  "$(cd "$sandbox_real_home" && pwd -P)"/*)
    echo "sandbox: TMPDIR ($sandbox_root) is inside the real home; set TMPDIR outside it" >&2
    rm -rf "$sandbox_root"; exit 1 ;;
esac
trap 'rm -rf "$sandbox_root"' EXIT
fresh_home() { mktemp -d "$sandbox_root/home.XXXXXX"; } # a new empty HOME, under the checked root
HOME="$(fresh_home)" || exit 1
export HOME
unset XDG_DATA_HOME
