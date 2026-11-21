package buildinfo

import (
	"fmt"
	"strconv"
	"strings"
)

// Version is replaced from package.json by the release build script.
var Version = "0.1.0"

// CompatibilityVersion changes only when the client/server protocol baseline changes.
var CompatibilityVersion = "0.1.0"

const MinimumClientVersion = "0.1.0"

type semanticVersion struct {
	major      int
	minor      int
	patch      int
	prerelease string
}

// PublicVersion returns a coarse release series that is safe to expose publicly.
func PublicVersion() string {
	version, ok := parseSemanticVersion(Version)
	if !ok {
		return "development"
	}
	return fmt.Sprintf("%d.%d.x", version.major, version.minor)
}

func IsVersionOlder(current string, minimum string) bool {
	currentVersion, currentOK := parseSemanticVersion(current)
	minimumVersion, minimumOK := parseSemanticVersion(minimum)
	if !currentOK || !minimumOK {
		return false
	}
	return compareSemanticVersions(currentVersion, minimumVersion) < 0
}

func parseSemanticVersion(value string) (semanticVersion, bool) {
	value = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "v"))
	if buildIndex := strings.IndexByte(value, '+'); buildIndex >= 0 {
		value = value[:buildIndex]
	}
	version := semanticVersion{}
	if prereleaseIndex := strings.IndexByte(value, '-'); prereleaseIndex >= 0 {
		version.prerelease = value[prereleaseIndex+1:]
		value = value[:prereleaseIndex]
		if version.prerelease == "" {
			return semanticVersion{}, false
		}
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return semanticVersion{}, false
	}
	values := []*int{&version.major, &version.minor, &version.patch}
	for index, part := range parts {
		parsed, err := strconv.Atoi(part)
		if err != nil || parsed < 0 || (len(part) > 1 && part[0] == '0') {
			return semanticVersion{}, false
		}
		*values[index] = parsed
	}
	return version, true
}

func compareSemanticVersions(left semanticVersion, right semanticVersion) int {
	for _, values := range [][2]int{{left.major, right.major}, {left.minor, right.minor}, {left.patch, right.patch}} {
		if values[0] < values[1] {
			return -1
		}
		if values[0] > values[1] {
			return 1
		}
	}
	if left.prerelease == right.prerelease {
		return 0
	}
	if left.prerelease == "" {
		return 1
	}
	if right.prerelease == "" {
		return -1
	}
	return comparePrerelease(left.prerelease, right.prerelease)
}

func comparePrerelease(left string, right string) int {
	leftParts := strings.Split(left, ".")
	rightParts := strings.Split(right, ".")
	limit := min(len(leftParts), len(rightParts))
	for index := 0; index < limit; index++ {
		leftNumber, leftNumeric := numericIdentifier(leftParts[index])
		rightNumber, rightNumeric := numericIdentifier(rightParts[index])
		if leftNumeric && rightNumeric {
			if leftNumber < rightNumber {
				return -1
			}
			if leftNumber > rightNumber {
				return 1
			}
			continue
		}
		if leftNumeric != rightNumeric {
			if leftNumeric {
				return -1
			}
			return 1
		}
		if comparison := strings.Compare(leftParts[index], rightParts[index]); comparison != 0 {
			return comparison
		}
	}
	return len(leftParts) - len(rightParts)
}

func numericIdentifier(value string) (int, bool) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, false
	}
	parsed, err := strconv.Atoi(value)
	return parsed, err == nil
}
