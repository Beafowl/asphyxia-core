#!/bin/bash

mkdir -p build

regex='VERSION = '"'"'(.*)'"'"''
[[ $(cat ./src/util/Consts.ts) =~ $regex ]]

VERSION=${BASH_REMATCH[1]}

npx tsc

npx ncc build ./dist/AsphyxiaCore.js -o ./build-env --external uglify-js --external ts-node

npx pkg ./build-env -t node10.15.3-linux-armv7 -o ./build/asphyxia-core

rm -f build/asphyxia-$VERSION-armv7.zip
cd build
zip asphyxia-$VERSION-armv7.zip asphyxia-core