// Package webassets holds the Web client that ships inside the ev-server binary.
//
// The release build copies the built client (apps/desktop/dist) into ./dist
// before `go build`, so a released ev-server.exe can serve the Web client with
// `web.root: ""` and no files next to the executable.
//
// The committed placeholder keeps `go build` working from a clean checkout: the
// embed directive fails to compile if the directory is missing, and a build
// without assets should still produce a runnable server (it simply reports that
// no embedded client is available).
package webassets

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var bundled embed.FS

// FS returns the embedded Web client files. The tree is rooted at the dist
// directory, so "index.html" is the entry point when a release build bundled it.
func FS() fs.FS {
	sub, err := fs.Sub(bundled, "dist")
	if err != nil {
		// fs.Sub only fails for a malformed path, which is a programming error.
		panic(err)
	}
	return sub
}

// HasIndex reports whether the binary carries a usable Web client. A build that
// only has the placeholder returns false.
func HasIndex() bool {
	info, err := fs.Stat(FS(), "index.html")
	return err == nil && !info.IsDir()
}
