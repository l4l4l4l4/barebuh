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
