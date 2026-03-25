{
  description = "Generic dev shell for Node.js project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      perSystem = { config, self', inputs', pkgs, system, lib, ... }:
        {
          devShells = {
            default = pkgs.mkShell {
              packages = with pkgs; [
                nodejs
                pnpm
                yarn
                typescript
                nodePackages.typescript-language-server
                nodePackages.prettier
                nodePackages.eslint
              ];
            };
          };
        };
    };
}
