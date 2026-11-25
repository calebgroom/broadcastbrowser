#!/bin/sh
# Builds the stand-in Desktop Video library (fake.cc) into test/build/libDeckLinkAPI.so (Linux only).
set -e
cd "$(dirname "$0")"
mkdir -p build
g++ -std=c++17 -O1 -shared -fPIC -I../sdk/Linux fake.cc -o build/libDeckLinkAPI.so -lpthread
echo "built test/build/libDeckLinkAPI.so: run with LD_LIBRARY_PATH=$(pwd)/build"
