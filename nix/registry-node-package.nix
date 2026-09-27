{ lib, stdenvNoCC, makeWrapper, nodejs_24 }:

stdenvNoCC.mkDerivation {
  pname = "barebuh-registry-node";
  version = "0.0.1";
  src = ../registry-node;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec/barebuh-registry-node" "$out/bin"
    cp -R migrations package.json src "$out/libexec/barebuh-registry-node/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/barebuh-registry-node" \
      --add-flags "$out/libexec/barebuh-registry-node/src/cli.mjs"
    runHook postInstall
  '';

  meta = {
    description = "Private read-only Barebuh registry-node scaffold";
    license = lib.licenses.gpl3Plus;
    mainProgram = "barebuh-registry-node";
    platforms = lib.platforms.unix;
  };
}
