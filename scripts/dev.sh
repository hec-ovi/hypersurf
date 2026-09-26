#!/bin/sh
# Dev tasks. Node runs only inside Docker; nothing is installed on the host.
#   scripts/dev.sh test          run the test suite (node:test)
#   scripts/dev.sh serve [port]  serve the site locally (default 8080)
#   scripts/dev.sh node <args>   run node in the container
set -eu
cd "$(dirname "$0")/.."
NODE="docker run --rm -i -u $(id -u):$(id -g) -v $PWD:/src -w /src node:24-alpine"
case "${1:-}" in
  test) shift; exec $NODE node --test "$@" ;;
  serve) exec docker run --rm -p "127.0.0.1:${2:-8080}:8080" -v "$PWD:/srv:ro" -w /srv node:24-alpine \
      node -e "require('http').createServer((q,s)=>{const f=require('path').join('/srv',decodeURIComponent(q.url.split('?')[0]).replace(/\/$/,'/index.html'));require('fs').readFile(f,(e,d)=>{if(e){s.writeHead(404);return s.end()}const t={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm'}[require('path').extname(f)]||'application/octet-stream';s.writeHead(200,{'content-type':t});s.end(d)})}).listen(8080)" ;;
  node) shift; exec $NODE node "$@" ;;
  *) echo "usage: scripts/dev.sh test|serve [port]|node <args>" >&2; exit 2 ;;
esac
