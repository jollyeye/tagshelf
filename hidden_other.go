//go:build !windows

package main

import (
	"io/fs"
	"strings"
)

func isHiddenInfo(info fs.FileInfo, name string) bool { return strings.HasPrefix(name, ".") }
