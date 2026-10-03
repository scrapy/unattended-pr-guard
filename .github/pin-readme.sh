#!/bin/bash
# Points the README example at the commit that bump-my-version just tagged,
# which cannot carry its own hash.
set -euo pipefail
sed -i -E "s|(unattended-pr-guard@)[^ ]+ # [0-9.]+|\1$(git rev-parse HEAD) # $BVHOOK_NEW_VERSION|" README.md
git commit -m "Pin the README example to $BVHOOK_NEW_VERSION" README.md
