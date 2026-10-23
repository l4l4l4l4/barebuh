{
  description = "Barebuh open radio registry protocol and private node";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          registry-node = pkgs.callPackage ./nix/registry-node-package.nix { };
          default = self.packages.${system}.registry-node;
        });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          testSource = builtins.path {
            path = ./.;
            name = "barebuh-source";
            filter = path: type:
              let base = baseNameOf path;
              in !(base == ".git" || base == "build" || base == "result");
          };
          registryNode = pkgs.callPackage ./nix/registry-node-package.nix { };
        in {
          protocol-v1 = pkgs.runCommand "barebuh-protocol-v1-check" {
            nativeBuildInputs = [ pkgs.gnumake pkgs.nodejs_24 ];
          } ''
            make -C ${testSource}/protocol/v1 check
            touch $out
          '';
          registry-node = pkgs.runCommand "barebuh-registry-node-check" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            cd ${testSource}/registry-node
            node --test
            touch $out
          '';
          migrations = pkgs.runCommand "barebuh-registry-migration-check" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            cd ${testSource}/registry-node
            node --test test/db.test.mjs
            touch $out
          '';
          packaged-cli = pkgs.runCommand "barebuh-registry-node-packaged-check" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            # The packaged CLI must be usable on its own: this proves that the shared protocol
            # library shipped next to it still resolves and that a real signed envelope can be
            # ingested, materialized, verified, and locally suppressed.
            export HOME="$TMPDIR"
            work="$(mktemp -d)"
            export BAREBUH_DATABASE_PATH="$work/registry.sqlite3"
            bin=${registryNode}/bin/barebuh-registry-node
            "$bin" effective-config > /dev/null
            "$bin" migrate | grep -q '"schemaVersion":3'
            "$bin" check-db | grep -q '"quickCheck":"ok"'
            station="$(${pkgs.nodejs_24}/bin/node ${testSource}/registry-node/test/emit-envelope.mjs "$work")"
            "$bin" ingest "$work/envelope-0.json" | grep -q '"status":"stored"'
            "$bin" ingest "$work/envelope-1.json" | grep -q '"state":"active"'
            "$bin" ingest "$work/envelope-1.json" | grep -q '"status":"duplicate"'
            "$bin" check-projection | grep -q '"mismatches": \[\]'
            "$bin" station "$station" | grep -q '"name": "Smoke Test FM renewed"'
            "$bin" rebuild | grep -q '"forced":false'
            "$bin" set-policy "$("$bin" station "$station" | grep -o '"visibleRecordId": "[^"]*"' | cut -d'"' -f4)" suppressed | grep -q '"state":"suppressed"'
            "$bin" drain | grep -q '"remaining":0'
            # The packaged CLI must resolve the federation modules too: pins and the pull worker are
            # part of the shipped surface, and they stay inert outside the pinned-federation mode.
            BAREBUH_MODE=PRIVATE_PINNED_FEDERATION BAREBUH_FEDERATION_ENABLED=true "$bin" peer-list | grep -q '"peers": \[\]'
            BAREBUH_MODE=PRIVATE_PINNED_FEDERATION BAREBUH_FEDERATION_ENABLED=true "$bin" peer-add oradio:node:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK8 https://peer.example/v1/ peer-a | grep -q '"label":"peer-a"'
            BAREBUH_MODE=PRIVATE_PINNED_FEDERATION BAREBUH_FEDERATION_ENABLED=true "$bin" peer-list | grep -q 'oradio:node:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK8'
            touch $out
          '';
        });

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShellNoCC {
            packages = [ pkgs.gnumake pkgs.nodejs_24 pkgs.sqlite ];
          };
        });
    };
}
