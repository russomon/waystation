#!/usr/bin/env bash
# Fetch Netflix's Photon (IMF validator) + its full dependency tree from
# Maven Central into vendor/photon/ so Rule 4 (SMPTE ST 2067-21 validation)
# executes for real. Requires: brew install openjdk maven
# Then set in .env:  PHOTON_JAR=<repo>/vendor/photon
set -euo pipefail
export PATH="/opt/homebrew/opt/openjdk/bin:/opt/homebrew/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-5.0.1}"
DEST="$WEB/vendor/photon"
mkdir -p "$DEST"

command -v mvn >/dev/null || { echo "✗ maven missing — brew install maven"; exit 1; }
command -v java >/dev/null || { echo "✗ java missing — brew install openjdk"; exit 1; }

# throwaway pom: depend on Photon, let maven resolve the transitive tree
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/pom.xml" <<POM
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>waystation</groupId><artifactId>photon-fetch</artifactId><version>1</version>
  <dependencies>
    <dependency>
      <groupId>com.netflix.photon</groupId><artifactId>Photon</artifactId>
      <version>${VERSION}</version>
    </dependency>
  </dependencies>
</project>
POM
( cd "$TMP" && mvn -q dependency:copy-dependencies -DoutputDirectory="$DEST" -DincludeScope=runtime )
COUNT=$(ls "$DEST"/*.jar | wc -l | tr -d ' ')
echo "✓ $COUNT jar(s) in $DEST (Photon $VERSION + dependencies)"
echo "  add to .env:  PHOTON_JAR=$DEST"
java -cp "$DEST/*" com.netflix.imflibrary.app.IMPAnalyzer 2>&1 | head -3 || true
