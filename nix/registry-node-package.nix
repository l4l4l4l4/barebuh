{ lib, stdenvNoCC, makeWrapper, nodejs_24, protocolSrc ? ../protocol }:

# The store, ingest, and materializer modules import the shared protocol library through a relative
# path (`../../../protocol/v1/lib/conformance.mjs`), so `libexec` mirrors the repository layout:
# `registry-node/` and `protocol/` sit side by side and the relative imports keep resolving.
stdenvNoCC.mkDerivation {
  pname = "barebuh-registry-node";
  version = "0.0.1";
  src = ../registry-node;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec/registry-node" "$out/libexec/protocol" "$out/bin"
    cp -R migrations package.json src "$out/libexec/registry-node/"
    cp -R ${protocolSrc}/v1 "$out/libexec/protocol/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/barebuh-registry-node" \
      --add-flags "$out/libexec/registry-node/src/cli.mjs"
    runHook postInstall
  '';

  meta = {
    description = "Private read-only Barebuh registry-node scaffold";
    license = lib.licenses.gpl3Plus;
    mainProgram = "barebuh-registry-node";
    platforms = lib.platforms.unix;
  };
}
