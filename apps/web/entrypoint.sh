#!/bin/sh
# Replaces the APP_NEXT_PUBLIC_* placeholders the image is built with by the
# container's NEXT_PUBLIC_* values (empty for a variable that is not set), then
# runs the given command.
set -eu

WEB_DIR="${WEB_DIR:-/app/apps/web}"
NEXT_DIR="$WEB_DIR/.next"
TEMPLATES="$WEB_DIR/.next-templates.tar"

# The image keeps a pristine copy of every file that carries a placeholder.
# Restoring it first makes each start substitute the current values, so a
# changed value applies on a plain restart.
if [ -f "$TEMPLATES" ]; then
  tar -xf "$TEMPLATES" -C "$WEB_DIR"
fi

# A value escaped for the replacement side of `s|...|...|`.
sed_escape() {
  printf '%s\n' "$1" | sed -e 's/[\\&|]/\\&/g'
}

newline='
'

# Longest names first, so a name that extends another is replaced whole.
names=$(env | sed -n 's/^\(NEXT_PUBLIC_[A-Za-z0-9_]*\)=.*/\1/p' \
  | awk '{ print length($0), $0 }' | sort -rn | cut -d' ' -f2)

for name in $names; do
  # The name matches [A-Za-z0-9_]+, so the eval only reads that variable.
  eval "value=\${$name-}"
  case "$value" in
    *"$newline"*)
      echo "Skipping $name: values spanning several lines are not supported" >&2
      continue
      ;;
  esac
  escaped=$(sed_escape "$value")
  echo "Setting APP_$name"
  grep -rlF "APP_$name" "$NEXT_DIR" | while IFS= read -r file; do
    sed -i "s|APP_$name|$escaped|g" "$file"
  done
done

# Variables whose app value has a default that only an explicitly empty value
# turns off (the 3D sources). Unset, their placeholder becomes the bare
# APP_NEXT_PUBLIC_ prefix, which the app reads as "not set" and so takes its
# default; set to empty, they were replaced by "" above.
UNSET_MEANS_DEFAULT="NEXT_PUBLIC_TERRAIN_TILES_URL NEXT_PUBLIC_BUILDINGS_TILES_URL"
for name in $UNSET_MEANS_DEFAULT; do
  eval "set_=\${$name+x}"
  [ -n "$set_" ] && continue
  echo "Leaving APP_$name to the app's default"
  grep -rlF "APP_$name" "$NEXT_DIR" | while IFS= read -r file; do
    sed -i "s|APP_$name|APP_NEXT_PUBLIC_|g" "$file"
  done
done

# What is left belongs to variables the container does not set (or skipped
# above). Each becomes empty, which the app reads as "not set": left in place,
# the placeholder's name would be taken for a value, e.g. fetched as a URL.
# The bare APP_NEXT_PUBLIC_ prefix the app compares values against is kept.
grep -rhoE 'APP_NEXT_PUBLIC_[A-Za-z0-9_]+' "$NEXT_DIR" | sort -u | while IFS= read -r placeholder; do
  echo "Clearing $placeholder"
done
grep -rl 'APP_NEXT_PUBLIC_[A-Za-z0-9_]' "$NEXT_DIR" | while IFS= read -r file; do
  sed -i 's/APP_NEXT_PUBLIC_[A-Za-z0-9_][A-Za-z0-9_]*//g' "$file"
done

echo "Starting Nextjs"
exec "$@"
