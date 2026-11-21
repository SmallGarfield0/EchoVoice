package buildinfo

import "testing"

func TestIsVersionOlder(t *testing.T) {
	tests := []struct {
		current string
		minimum string
		older   bool
	}{
		{"0.1.0", "0.1.0", false},
		{"0.0.9", "0.1.0", true},
		{"1.0.0", "0.9.9", false},
		{"v0.1.0-beta.1", "0.1.0", true},
		{"0.1.0", "0.1.0-beta.1", false},
		{"development", "0.1.0", false},
	}
	for _, test := range tests {
		if actual := IsVersionOlder(test.current, test.minimum); actual != test.older {
			t.Fatalf("IsVersionOlder(%q, %q) = %t, want %t", test.current, test.minimum, actual, test.older)
		}
	}
}

func TestPublicVersion(t *testing.T) {
	original := Version
	t.Cleanup(func() { Version = original })

	Version = "v2.7.13-beta.1+build.4"
	if actual := PublicVersion(); actual != "2.7.x" {
		t.Fatalf("expected public version 2.7.x, got %q", actual)
	}
	Version = "development"
	if actual := PublicVersion(); actual != "development" {
		t.Fatalf("expected development fallback, got %q", actual)
	}
}
