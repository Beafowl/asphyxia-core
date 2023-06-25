#!/bin/bash

echo "Packing binaries"
npx pkg ./build-env -t node16.15.0-linux-arm64 -o ./build/asphyxia-core --options no-warnings
