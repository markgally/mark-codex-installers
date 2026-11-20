#!/bin/bash
# Sign the finished Mark Codex.exe with SSL.com eSigner and repack the setup ZIP.
# Secrets are read from the environment and are never printed.
set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REALTIME_DIR=$(cd "$PROJECT_DIR/.." && pwd)
STAGE=${1:-"$REALTIME_DIR/outputs/MARK-Codex-Windows-x64-Setup-0.2.7"}
EXE="$STAGE/Mark Codex.exe"
TOOLS="$PROJECT_DIR/.signing-tools"
JSIGN_VERSION=6.0
OPENSSL_VERSION=3.4.1
OSSLSIGNCODE_VERSION=2.9

missing=()
for name in ESIGNER_USERNAME ESIGNER_PASSWORD ESIGNER_CREDENTIAL_ID ESIGNER_TOTP_SECRET; do
  if [[ -z ${!name:-} ]]; then
    missing+=("$name")
  fi
done
if ((${#missing[@]} > 0)); then
  echo "Missing SSL.com eSigner environment: ${missing[*]}" >&2
  echo "The package was not changed. Set those four values and run this script again." >&2
  exit 1
fi

if [[ ! -f $EXE ]]; then
  echo "Finished executable not found: $EXE" >&2
  exit 1
fi

download() {
  curl --fail --silent --show-error --location --output "$2" "$1"
}

ensure_java() {
  if [[ -x $TOOLS/jre/Contents/Home/bin/java ]]; then
    JAVA=$TOOLS/jre/Contents/Home/bin/java
    return
  fi
  if /usr/bin/java -version >/dev/null 2>&1; then
    JAVA=/usr/bin/java
    return
  fi
  mkdir -p "$TOOLS"
  local archive=$TOOLS/temurin-jre.tar.gz
  download "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jre/hotspot/normal/eclipse?project=jdk" "$archive"
  tar -xzf "$archive" -C "$TOOLS"
  local home
  home=$(find "$TOOLS" -type d -path '*/Contents/Home' | head -n 1)
  if [[ -z $home || ! -x $home/bin/java ]]; then
    echo "Could not install a local Java runtime." >&2
    exit 1
  fi
  rm -rf "$TOOLS/jre"
  mkdir -p "$TOOLS/jre"
  cp -R "$(dirname "$(dirname "$home")")"/. "$TOOLS/jre/"
  JAVA=$TOOLS/jre/Contents/Home/bin/java
}

ensure_jsign() {
  local jar=$TOOLS/jsign-$JSIGN_VERSION.jar
  if [[ ! -f $jar ]]; then
    mkdir -p "$TOOLS"
    download "https://github.com/ebourg/jsign/releases/download/$JSIGN_VERSION/jsign-$JSIGN_VERSION.jar" "$jar"
  fi
  JSIGN_JAR=$jar
}

ensure_cmake() {
  if command -v cmake >/dev/null 2>&1; then
    CMAKE=$(command -v cmake)
    return
  fi
  if [[ -x $TOOLS/cmake/CMake.app/Contents/bin/cmake ]]; then
    CMAKE=$TOOLS/cmake/CMake.app/Contents/bin/cmake
    return
  fi
  mkdir -p "$TOOLS/src"
  local archive=$TOOLS/src/cmake.tar.gz
  download "https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-macos-universal.tar.gz" "$archive"
  rm -rf "$TOOLS/cmake"
  mkdir -p "$TOOLS/cmake"
  tar -xzf "$archive" -C "$TOOLS/cmake" --strip-components=1
  CMAKE=$TOOLS/cmake/CMake.app/Contents/bin/cmake
}

ensure_osslsigncode() {
  if command -v osslsigncode >/dev/null 2>&1; then
    OSSLSIGNCODE=$(command -v osslsigncode)
    return
  fi
  if [[ -x $TOOLS/osslsigncode/bin/osslsigncode ]]; then
    OSSLSIGNCODE=$TOOLS/osslsigncode/bin/osslsigncode
    return
  fi
  ensure_cmake
  mkdir -p "$TOOLS/src" "$TOOLS/openssl" "$TOOLS/osslsigncode"
  local openssl_tar=$TOOLS/src/openssl-$OPENSSL_VERSION.tar.gz
  local sign_tar=$TOOLS/src/osslsigncode-$OSSLSIGNCODE_VERSION.tar.gz
  download "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" "$openssl_tar"
  download "https://github.com/mtrojnar/osslsigncode/releases/download/$OSSLSIGNCODE_VERSION/osslsigncode-$OSSLSIGNCODE_VERSION.tar.gz" "$sign_tar"
  tar -xzf "$openssl_tar" -C "$TOOLS/src"
  tar -xzf "$sign_tar" -C "$TOOLS/src"
  (
    cd "$TOOLS/src/openssl-$OPENSSL_VERSION"
    ./Configure darwin64-arm64 --prefix="$TOOLS/openssl" --libdir=lib no-shared no-tests
    make -j"$(sysctl -n hw.ncpu)"
    make install_sw
  )
  (
    cd "$TOOLS/src/osslsigncode-$OSSLSIGNCODE_VERSION"
    "$CMAKE" -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$TOOLS/openssl" -DCMAKE_INSTALL_PREFIX="$TOOLS/osslsigncode"
    "$CMAKE" --build build
    "$CMAKE" --install build
  )
  OSSLSIGNCODE=$TOOLS/osslsigncode/bin/osslsigncode
  if [[ ! -x $OSSLSIGNCODE ]]; then
    echo "Could not install osslsigncode." >&2
    exit 1
  fi
}

ensure_java
ensure_jsign
ensure_osslsigncode

export ESIGNER_USERNAME_PASSWORD="${ESIGNER_USERNAME}|${ESIGNER_PASSWORD}"
"$JAVA" -jar "$JSIGN_JAR" \
  --storetype ESIGNER \
  --storepass env:ESIGNER_USERNAME_PASSWORD \
  --alias "$ESIGNER_CREDENTIAL_ID" \
  --keypass env:ESIGNER_TOTP_SECRET \
  --tsaurl http://timestamp.sectigo.com \
  --tsmode RFC3161 \
  "$EXE"
unset ESIGNER_USERNAME_PASSWORD

verify_output=$("$OSSLSIGNCODE" verify -in "$EXE" 2>&1 || true)
python3 -c '
import re, sys
text = sys.stdin.read()
low = text.lower()
if "no signature" in low or "unable to extract" in low or "not signed" in low:
    sys.exit("Mark Codex.exe has no Authenticode signature")
if not re.search(r"signature index|signer", low):
    sys.exit("Mark Codex.exe has no Authenticode signature")
if "timestamp" not in low:
    sys.exit("Mark Codex.exe signature is not timestamped")
subjects = [item.strip() for item in re.findall(r"(?im)^[ \t]*subject\s*[:=]\s*(.+)$", text)]
issuers = [item.strip() for item in re.findall(r"(?im)^[ \t]*issuer\s*[:=]\s*(.+)$", text)]
if subjects and issuers and subjects[0] == issuers[0]:
    sys.exit("Mark Codex.exe is self-signed")
print("Authenticode signature and timestamp verified")
' <<<"$verify_output"

python3 - "$STAGE" <<'PY'
import hashlib, pathlib, sys, zipfile
stage = pathlib.Path(sys.argv[1])
exe = stage / "Mark Codex.exe"
start = stage / "START HERE.txt"
info = stage / "BUILD-INFO.json"
sums = stage / "SHA256SUMS.txt"
old = "Do not run from inside the ZIP. This is an unsigned Windows x64 release."
new = "Do not run from inside the ZIP. Mark Codex.exe is Authenticode-signed and timestamped."
raw = start.read_bytes()
newline = b"\r\n" if b"\r\n" in raw else b"\n"
text = raw.replace(b"\r\n", b"\n").decode("utf-8")
if old in text:
    text = text.replace(old, new)
elif new not in text:
    raise SystemExit("START HERE.txt does not describe the Windows signature")
start.write_bytes(text.replace("\n", newline.decode("ascii")).encode("utf-8"))
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
info_text = info.read_text()
updated, count = __import__("re").subn(
    r'("mark_executable_sha256": ")[0-9a-fA-F]{64}(")',
    rf"\g<1>{digest}\2",
    info_text,
    count=1,
)
if count != 1:
    raise SystemExit("BUILD-INFO.json is missing mark_executable_sha256")
info.write_text(updated)
lines = []
for path in sorted(item for item in stage.rglob("*") if item.is_file() and item.name != "SHA256SUMS.txt"):
    relative = path.relative_to(stage).as_posix()
    file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{file_hash}  {relative}")
sums.write_text("\n".join(lines) + "\n")
archive = stage.parent / f"{stage.name}.zip"
temporary = archive.with_suffix(".zip.new")
with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(item for item in stage.rglob("*") if item.is_file()):
        bundle.write(path, path.relative_to(stage).as_posix())
temporary.replace(archive)
print(digest)
PY

README="/Users/markgally/Documents/mark-codex-installers/README.md"
python3 - "$README" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "These builds are unsigned. macOS and Windows may warn before they open."
new = "The Windows Mark Codex.exe is Authenticode-signed and timestamped. The Mac app is still unsigned, so macOS may warn before it opens."
if old in text:
    text = text.replace(old, new)
elif new not in text:
    raise SystemExit("Installer README does not describe the Windows signature")
path.write_text(text)
PY

if [[ -d /Users/markgally/Documents/mark-codex-installers/.git ]]; then
  git -C /Users/markgally/Documents/mark-codex-installers add README.md
  GIT_AUTHOR_NAME="Mark Gally Reboton" \
  GIT_AUTHOR_EMAIL="markgally@Marks-MacBook-Pro.local" \
  GIT_COMMITTER_NAME="Mark Gally Reboton" \
  GIT_COMMITTER_EMAIL="markgally@Marks-MacBook-Pro.local" \
  git -C /Users/markgally/Documents/mark-codex-installers commit -m "$(cat <<'EOF'
Note that the Windows executable is signed.

EOF
)"
  git -C /Users/markgally/Documents/mark-codex-installers push origin HEAD
fi

GH=${GH:-$HOME/.local/bin/gh}
"$GH" release upload v0.2.7 \
  "$STAGE/../MARK-Codex-Windows-x64-Setup-0.2.7.zip" \
  --repo markgally/mark-codex-installers \
  --clobber
