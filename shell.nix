{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  packages = [
    pkgs.python3
    pkgs.python3Packages.flask
    pkgs.python3Packages.shapely
    pkgs.tilemaker
    pkgs.cloudflared
    pkgs.git
    pkgs.osmium-tool
  ];
}
